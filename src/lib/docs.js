// docs.js — client library for the Docs feature (Supabase Storage + metadata).

import { supabase, getIdentity } from './supabase';

const BUCKET = 'docs';
export const MAX_DOC_BYTES = 5 * 1024 * 1024;   // 5 MB
export const ALLOWED_DOC_TYPES = {
  'application/pdf': 'pdf',
  'text/html': 'html',
};

export function fileKindFromType(mime, filename = '') {
  if (ALLOWED_DOC_TYPES[mime]) return ALLOWED_DOC_TYPES[mime];
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

export async function loadDocuments() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[docs] load error', error); return []; }
  return (data || []).map(r => ({
    id: r.id, name: r.name, filePath: r.file_path, fileType: r.file_type,
    sizeBytes: r.size_bytes, tags: r.tags || [], starred: r.starred,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

// Upload a File object. Returns { doc } or { error }.
export async function uploadDocument(file, { name, tags = [] } = {}) {
  if (!supabase) return { error: 'Storage not configured' };
  const identity = getIdentity();

  const kind = fileKindFromType(file.type, file.name);
  if (!kind) return { error: 'Only PDF and HTML files are supported.' };
  if (file.size > MAX_DOC_BYTES) return { error: 'File exceeds the 5 MB limit.' };

  const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  // Namespace by identity so each user's files live under their own folder.
  const safeName = (name || file.name).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  const path = `${identity}/${id}_${safeName}`;

  // Force the correct content type. Browser-reported file.type is often empty or
  // 'application/octet-stream' for Claude-generated HTML, which would otherwise
  // make it download rather than render. Derive it from the detected kind.
  const contentType = kind === 'pdf' ? 'application/pdf' : 'text/html';
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType, upsert: false });
  if (upErr) { console.warn('[docs] upload error', upErr); return { error: upErr.message }; }

  const doc = {
    id, identity,
    name: (name || file.name.replace(/\.[^.]+$/, '')).slice(0, 120),
    file_path: path, file_type: kind, size_bytes: file.size,
    tags, starred: false,
  };
  const { error: dbErr } = await supabase.from('documents').insert(doc);
  if (dbErr) {
    // Roll back the uploaded object if metadata insert fails.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    console.warn('[docs] metadata insert error', dbErr);
    return { error: dbErr.message };
  }
  return { doc: {
    id, name: doc.name, filePath: path, fileType: kind, sizeBytes: file.size,
    tags, starred: false, createdAt: new Date().toISOString(),
  }};
}

export async function renameDocument(id, name) {
  if (!supabase) return;
  await supabase.from('documents')
    .update({ name: name.slice(0, 120), updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function setDocumentStarred(id, starred) {
  if (!supabase) return;
  await supabase.from('documents')
    .update({ starred, updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function setDocumentTags(id, tags) {
  if (!supabase) return;
  await supabase.from('documents')
    .update({ tags, updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function deleteDocument(doc) {
  if (!supabase) return;
  await supabase.storage.from(BUCKET).remove([doc.filePath]).catch(() => {});
  await supabase.from('documents').delete().eq('id', doc.id);
}

// Get a temporary signed URL to view/download a file (bucket is private).
export async function getDocumentUrl(doc, { download = false } = {}) {
  if (!supabase) return null;
  const opts = download ? { download: true } : {};
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.filePath, 60 * 10, opts);   // 10 minutes
  if (error) { console.warn('[docs] signed url error', error); return null; }
  return data?.signedUrl || null;
}

// Download the raw file bytes. Returns a Blob (or null).
// Used to render HTML inside the app (Supabase Storage won't render HTML inline
// itself — it serves it with a restrictive CSP / forces download — so we fetch
// the bytes and render them in a sandboxed iframe within our own page instead).
export async function downloadDocumentBlob(doc) {
  if (!supabase) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(doc.filePath);
  if (error) { console.warn('[docs] download error', error); return null; }
  return data || null;   // Blob
}

// Fetch an HTML document's text content, ready to inject into an iframe srcdoc.
export async function fetchDocumentHtml(doc) {
  const blob = await downloadDocumentBlob(doc);
  if (!blob) return null;
  try { return await blob.text(); }
  catch { return null; }
}

// Build an object URL for a blob (used for PDF viewing in an iframe/embed).
export async function documentObjectUrl(doc) {
  const blob = await downloadDocumentBlob(doc);
  if (!blob) return null;
  // Ensure the blob has the right type so the browser renders it correctly.
  const typed = doc.fileType === 'pdf'
    ? new Blob([blob], { type: 'application/pdf' })
    : new Blob([blob], { type: 'text/html' });
  return URL.createObjectURL(typed);
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n/1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)} KB`;
  return `${n} B`;
}
