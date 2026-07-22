// DayLog 2.0 — data access layer.
//
// Every write goes to Supabase first, then updates the IndexedDB cache. Reads
// try Supabase and fall back to cache when offline. Supabase is always the
// source of truth; the cache is a performance/offline mirror.

import { supabase } from "../supabase.js";
import { cache } from "./cache.js";

function online() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

async function currentUserId() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

// ---------------------------------------------------------------------------
// Day entries
// ---------------------------------------------------------------------------
export const entries = {
  // Returns all day entries newest-first. Reads Supabase; falls back to cache.
  async list() {
    if (online()) {
      const { data, error } = await supabase
        .from("day_entries")
        .select("*, meetings(*), photos(*)")
        .order("entry_date", { ascending: false });
      if (error) throw error;
      await cache.replace("day_entries", data);
      return data;
    }
    return (await cache.all("day_entries"))
      .sort((a, b) => String(b.entry_date).localeCompare(String(a.entry_date)));
  },

  // Upsert a day entry (one per user/date). Writes Supabase then cache.
  async save({ id, entry_date, daily_notes, future_plans }) {
    const uid = await currentUserId();
    if (!uid) throw new Error("Not signed in.");
    const row = {
      user_id: uid,
      entry_date,
      daily_notes,
      future_plans: future_plans || "",
    };
    if (id) row.id = id;
    const { data, error } = await supabase
      .from("day_entries")
      .upsert(row, { onConflict: "user_id,entry_date" })
      .select("*, meetings(*), photos(*)")
      .single();
    if (error) throw error;
    await cache.put("day_entries", data);
    return data;
  },

  async remove(id) {
    const { error } = await supabase.from("day_entries").delete().eq("id", id);
    if (error) throw error;
    await cache.delete("day_entries", id);
  },
};

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------
export const meetings = {
  async add(meeting) {
    const uid = await currentUserId();
    if (!uid) throw new Error("Not signed in.");
    const row = {
      user_id: uid,
      day_entry_id: meeting.day_entry_id ?? null,
      title: meeting.title,
      notes: meeting.notes || "",
      starts_at: meeting.starts_at,
      ends_at: meeting.ends_at,
      duration_minutes: meeting.duration_minutes ?? 60,
      detected: meeting.detected ?? true,
    };
    const { data, error } = await supabase
      .from("meetings").insert(row).select().single();
    if (error) throw error;
    await cache.put("meetings", data);

    // Retain the detection record so reminders survive re-export.
    if (meeting.source_text) {
      await supabase.from("reminder_metadata").insert({
        user_id: uid,
        meeting_id: data.id,
        source_text: meeting.source_text,
        detected_date: meeting.detected_date ?? null,
        detected_time: meeting.detected_time ?? null,
      });
    }
    return data;
  },

  async remove(id) {
    const { error } = await supabase.from("meetings").delete().eq("id", id);
    if (error) throw error;
    await cache.delete("meetings", id);
  },
};

// ---------------------------------------------------------------------------
// Photos (metadata rows; blobs handled by storage.js)
// ---------------------------------------------------------------------------
export const photos = {
  async add(meta) {
    const uid = await currentUserId();
    if (!uid) throw new Error("Not signed in.");
    const row = {
      user_id: uid,
      day_entry_id: meta.day_entry_id ?? null,
      storage_path: meta.storage_path ?? null,
      mime_type: meta.mime_type || "image/jpeg",
      width: meta.width ?? null,
      height: meta.height ?? null,
      byte_size: meta.byte_size ?? null,
      is_backed_up: Boolean(meta.storage_path),
      local_ref: meta.local_ref ?? null,
    };
    const { data, error } = await supabase
      .from("photos").insert(row).select().single();
    if (error) throw error;
    await cache.put("photos", data);
    return data;
  },

  async remove(id) {
    const { error } = await supabase.from("photos").delete().eq("id", id);
    if (error) throw error;
    await cache.delete("photos", id);
  },
};

// ---------------------------------------------------------------------------
// My Card (one row per user)
// ---------------------------------------------------------------------------
export const myCard = {
  async get() {
    const uid = await currentUserId();
    if (!uid) return null;
    if (online()) {
      const { data, error } = await supabase
        .from("my_cards").select("*").eq("user_id", uid).maybeSingle();
      if (error) throw error;
      if (data) await cache.put("card", { id: "current", ...data });
      else await cache.delete("card", "current");
      return data;
    }
    const c = await cache.get("card", "current");
    return c || null;
  },

  async save({ front_path, back_path }) {
    const uid = await currentUserId();
    if (!uid) throw new Error("Not signed in.");
    const { data, error } = await supabase
      .from("my_cards")
      .upsert({ user_id: uid, front_path, back_path }, { onConflict: "user_id" })
      .select().single();
    if (error) throw error;
    await cache.put("card", { id: "current", ...data });
    return data;
  },

  async remove() {
    const uid = await currentUserId();
    if (!uid) return;
    const { error } = await supabase.from("my_cards").delete().eq("user_id", uid);
    if (error) throw error;
    await cache.delete("card", "current");
  },
};

// ---------------------------------------------------------------------------
// Business-card contacts
// ---------------------------------------------------------------------------
export const contacts = {
  async list() {
    if (online()) {
      const { data, error } = await supabase
        .from("business_card_contacts").select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      await cache.replace("contacts", data);
      return data;
    }
    return cache.all("contacts");
  },

  async save(contact) {
    const uid = await currentUserId();
    if (!uid) throw new Error("Not signed in.");
    const row = {
      user_id: uid,
      name: contact.name || "",
      company: contact.company || "",
      job_title: contact.job_title || "",
      phones: contact.phones || [],
      office_phones: contact.office_phones || [],
      emails: contact.emails || [],
      website: contact.website || "",
      address: contact.address || "",
      notes: contact.notes || "",
      raw_ocr_text: contact.raw_ocr_text || "",
      image_path: contact.image_path ?? null,
    };
    if (contact.id) row.id = contact.id;
    const { data, error } = await supabase
      .from("business_card_contacts").upsert(row).select().single();
    if (error) throw error;
    await cache.put("contacts", data);
    return data;
  },

  async remove(id) {
    const { error } = await supabase
      .from("business_card_contacts").delete().eq("id", id);
    if (error) throw error;
    await cache.delete("contacts", id);
  },
};

// ---------------------------------------------------------------------------
// Global search (Supabase Full Text Search RPC)
// ---------------------------------------------------------------------------
export async function globalSearch(query, maxRows = 50) {
  const term = (query || "").trim();
  if (!term) return [];
  const { data, error } = await supabase
    .rpc("global_search", { q: term, max_rows: maxRows });
  if (error) throw error;
  return data || [];
}
