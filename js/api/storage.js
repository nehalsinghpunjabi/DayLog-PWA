// DayLog 2.0 — photo storage helper.
//
// CRITICAL PHOTO POLICY:
//   The user's original photo always stays in Apple Photos. What we upload here
//   is an OPTIONAL backup/sync copy. DayLog never becomes the sole owner of an
//   image. The picker (input[type=file]) copies bytes from Apple Photos without
//   moving or deleting the source, so the original remains in the user's library
//   regardless of what happens here.
//
// Objects are namespaced "<uid>/<bucket-subpath>/<uuid>.<ext>" so Storage RLS
// (see migrations/0004_storage.sql) isolates each user.

import { supabase } from "../supabase.js";
import { cache } from "./cache.js";

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extFor(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/heic") return "heic";
  return "jpg";
}

async function imageDimensions(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dims;
  } catch {
    return { width: null, height: null };
  }
}

export const storageApi = {
  // Cache the original blob locally so the attachment is instantly viewable and
  // available offline. Returns a local reference id.
  async cacheLocal(blob, mime) {
    const localRef = uuid();
    await cache.putMedia(localRef, blob, mime);
    return localRef;
  },

  // Upload a backup copy to Supabase Storage. Returns the storage path, or null
  // if offline (the local cache copy still exists; sync can retry later).
  async uploadBackup(bucket, blob, mime) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    if (typeof navigator !== "undefined" && !navigator.onLine) return null;

    const subdir = bucket === "cards" ? "cards" : "photos";
    const path = `${user.id}/${subdir}/${uuid()}.${extFor(mime)}`;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, blob, { contentType: mime, upsert: false });
    if (error) throw error;
    return path;
  },

  // Full attach flow for a day-entry photo: cache locally (always) + optional
  // backup upload. dims are captured for the metadata row.
  async attachPhoto(blob, { backup = true } = {}) {
    const mime = blob.type || "image/jpeg";
    const localRef = await this.cacheLocal(blob, mime);
    const dims = await imageDimensions(blob);
    let storage_path = null;
    if (backup) {
      try {
        storage_path = await this.uploadBackup("photos", blob, mime);
      } catch (err) {
        console.warn("DayLog: photo backup upload failed, kept local copy.", err);
      }
    }
    return {
      local_ref: localRef,
      storage_path,
      mime_type: mime,
      width: dims.width,
      height: dims.height,
      byte_size: blob.size,
    };
  },

  // Card image: cache locally + upload backup, return { path, localRef }.
  async attachCardSide(blob) {
    const mime = blob.type || "image/jpeg";
    const localRef = await this.cacheLocal(blob, mime);
    let path = null;
    try {
      path = await this.uploadBackup("cards", blob, mime);
    } catch (err) {
      console.warn("DayLog: card backup upload failed, kept local copy.", err);
    }
    return { path, localRef };
  },

  // Resolve a viewable object URL for a photo. Prefers the cached local blob;
  // downloads from Storage on a cache miss (online).
  async resolveURL({ local_ref, storage_path }, bucket = "photos") {
    if (local_ref) {
      const url = await cache.getMediaURL(local_ref);
      if (url) return url;
    }
    if (storage_path) {
      const { data, error } = await supabase.storage
        .from(bucket).download(storage_path);
      if (!error && data) {
        // Re-seed the cache under the storage path so future reads are instant.
        await cache.putMedia(storage_path, data, data.type);
        return URL.createObjectURL(data);
      }
    }
    return null;
  },

  async removeBackup(bucket, storage_path) {
    if (!storage_path) return;
    try {
      await supabase.storage.from(bucket).remove([storage_path]);
    } catch (err) {
      console.warn("DayLog: could not remove storage object.", err);
    }
  },
};
