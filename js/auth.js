// DayLog 2.0 — authentication.
// Email/password via Supabase Auth today. Structured so Apple & Google OAuth
// can be enabled later by flipping on the provider in the Supabase dashboard and
// calling signInWithOAuth — no schema or UI-model changes required.

import { supabase } from "./supabase.js";

export const auth = {
  async currentSession() {
    const { data } = await supabase.auth.getSession();
    return data?.session ?? null;
  },

  async currentUser() {
    const { data } = await supabase.auth.getUser();
    return data?.user ?? null;
  },

  onChange(callback) {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      callback(session);
    });
    return () => data.subscription.unsubscribe();
  },

  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },

  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data.user;
  },

  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) throw error;
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },

  // Future providers — enabled per Supabase dashboard config.
  async signInWithApple() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "apple",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
  },

  async signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
  },
};
