// Storage for the mini web apps Muse writes. Each app is one self-contained
// HTML file plus an entry in index.json. Files live on local disk, or in a
// Vercel Blob store when BLOB_READ_WRITE_TOKEN is set (Vercel has no writable disk).
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { put, get, del } from "@vercel/blob";

export const MAX_APP_BYTES = 512 * 1024;
const ID_RE = /^[a-z0-9-]{1,64}$/;

class NotFound extends Error {}

class DiskFiles {
  constructor(dir) {
    this.dir = dir;
    this.label = dir;
  }
  async read(name) {
    try {
      return await readFile(path.join(this.dir, name), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new NotFound(name);
      throw err;
    }
  }
  async write(name, text) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, name), text);
  }
  async remove(name) {
    await rm(path.join(this.dir, name), { force: true });
  }
}

class BlobFiles {
  constructor(prefix, access, auth) {
    this.prefix = prefix;
    this.access = access;
    this.auth = auth; // { token } or { storeId }; the OIDC token itself comes from Vercel's runtime
    this.label = `Vercel Blob (${access}) ${prefix}`;
  }
  async read(name) {
    // useCache: false so an app edited seconds ago isn't served stale from the CDN.
    const result = await get(this.prefix + name, { ...this.auth, access: this.access, useCache: false });
    if (!result || result.statusCode !== 200) throw new NotFound(name);
    return new Response(result.stream).text();
  }
  async write(name, text) {
    await put(this.prefix + name, text, {
      ...this.auth,
      access: this.access,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: name.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
    });
  }
  async remove(name) {
    await del(this.prefix + name, this.auth);
  }
}

class UnavailableFiles {
  label = "unavailable";
  #fail() {
    throw new Error("App storage isn't set up. In Vercel, open Storage and connect a Blob store to this project, then redeploy.");
  }
  async read(name) {
    if (name === "index.json") throw new NotFound(name);
    this.#fail();
  }
  write() { this.#fail(); }
  remove() { this.#fail(); }
}

// Vercel names these BLOB_READ_WRITE_TOKEN / BLOB_STORE_ID, or with a custom prefix
// (e.g. MYSTORE_BLOB_READ_WRITE_TOKEN) when one is chosen while connecting the store.
function findEnv(suffix) {
  if (process.env[suffix]) return process.env[suffix];
  const key = Object.keys(process.env).find((k) => k.endsWith("_" + suffix) && process.env[k]);
  return key ? process.env[key] : "";
}

export function blobEnvNames() {
  return Object.keys(process.env).filter((k) => k.includes("BLOB")).sort();
}

export function createAppStore({ dir }) {
  const access = process.env.BLOB_ACCESS || "private";
  const token = findEnv("BLOB_READ_WRITE_TOKEN");
  if (token) return new AppStore(new BlobFiles("apps/", access, { token }));
  // Newer Vercel Blob connections use the project's OIDC identity plus a store id.
  const storeId = findEnv("BLOB_STORE_ID");
  if (storeId) return new AppStore(new BlobFiles("apps/", access, { storeId }));
  // Vercel's filesystem is read-only, so without Blob there is nowhere to keep apps.
  if (process.env.VERCEL) return new AppStore(new UnavailableFiles());
  return new AppStore(new DiskFiles(dir));
}

export class AppStore {
  constructor(files) {
    this.files = files;
    this.location = files.label;
  }

  async #readIndex() {
    try {
      return JSON.parse(await this.files.read("index.json"));
    } catch (err) {
      if (err instanceof NotFound) return [];
      throw err;
    }
  }

  #fileName(id) {
    if (!ID_RE.test(id)) throw new Error(`Invalid app id: ${id}`);
    return `${id}.html`;
  }

  async list() {
    const index = await this.#readIndex();
    return index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) {
    const index = await this.#readIndex();
    return index.find((a) => a.id === id) || null;
  }

  async readHtml(id) {
    try {
      return await this.files.read(this.#fileName(id));
    } catch (err) {
      if (err instanceof NotFound) throw new Error(`No app with id "${id}". Call list_apps to see ids.`);
      throw err;
    }
  }

  // Creates a new app when id is missing, otherwise overwrites that app.
  async save({ id, title, description, html }) {
    const index = await this.#readIndex();
    let entry = id ? index.find((a) => a.id === id) : null;
    if (id && !entry) throw new Error(`No app with id "${id}". Call list_apps to see ids.`);
    const now = new Date().toISOString();
    if (!entry) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";
      entry = { id: `${slug}-${randomBytes(2).toString("hex")}`, createdAt: now };
      index.push(entry);
    }
    Object.assign(entry, { title, description, updatedAt: now });
    await this.files.write(this.#fileName(entry.id), html);
    await this.files.write("index.json", JSON.stringify(index, null, 2));
    return entry;
  }

  async remove(id) {
    const index = await this.#readIndex();
    const next = index.filter((a) => a.id !== id);
    if (next.length === index.length) throw new Error(`No app with id "${id}".`);
    await this.files.remove(this.#fileName(id));
    await this.files.write("index.json", JSON.stringify(next, null, 2));
  }
}
