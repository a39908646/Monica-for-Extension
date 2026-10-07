import { queryComposedAll } from "./composed-dom";
import { loginFieldRole, type LoginFieldRole } from "./login-field-role";
import { walletFieldName } from "./wallet-dom";
import type { AutofillFieldRole } from "../autofill/field-policy";

export type { AutofillFieldRole } from "../autofill/field-policy";

export interface AutofillFieldContext {
  signature: string;
  hostname: string;
  frameScope: "top-level" | "frame";
  role: AutofillFieldRole;
  hints: AutofillFieldRole[];
}

const MAX_STRUCTURAL_CONTROLS = 512;
const MAX_CREDENTIAL_TARGETS = 128;

export async function createCurrentFieldContext(rootDocument: Document = document, pageLocation: Location = location): Promise<AutofillFieldContext | undefined> {
  const active = deepActiveControl(rootDocument);
  if (!active) return undefined;
  return createFieldContext(active, rootDocument, pageLocation);
}

export async function createFieldContextsForRoot(root: ParentNode, rootDocument: Document = document, pageLocation: Location = location): Promise<AutofillFieldContext[]> {
  const controls = queryComposedAll<AutofillControl>(root, "input,select,textarea").slice(0, MAX_CREDENTIAL_TARGETS);
  const contexts = await Promise.all(controls.map((control) => createFieldContext(control, rootDocument, pageLocation)));
  return contexts.filter((context): context is AutofillFieldContext => Boolean(context));
}

async function createFieldContext(active: AutofillControl, rootDocument: Document, pageLocation: Location): Promise<AutofillFieldContext | undefined> {
  const role = fieldRole(active, rootDocument);
  if (!role) return undefined;

  const allControls = queryComposedAll<AutofillControl>(rootDocument, "input,select,textarea");
  const boundedControls = allControls.slice(0, MAX_STRUCTURAL_CONTROLS);
  if (!boundedControls.includes(active)) boundedControls.push(active);
  const forms = queryComposedAll<HTMLFormElement>(rootDocument, "form").slice(0, MAX_STRUCTURAL_CONTROLS);
  const targets = boundedControls.flatMap((control) => {
    const candidateRole = fieldRole(control, rootDocument);
    if (!candidateRole) return [];
    const formIndex = control.form ? boundedIndex(forms.indexOf(control.form)) : -1;
    return [`${candidateRole}@${boundedIndex(allControls.indexOf(control))}@${formIndex}@${isVisible(control) ? 1 : 0}`];
  }).slice(0, MAX_CREDENTIAL_TARGETS);
  const currentIndex = boundedIndex(allControls.indexOf(active));
  const currentFormIndex = active.form ? boundedIndex(forms.indexOf(active.form)) : -1;
  const hostname = normalizeHostname(pageLocation.hostname);
  if (!hostname) return undefined;
  const frameScope = isTopLevel(rootDocument) ? "top-level" : "frame";
  const raw = `${hostname}|${frameScope}|${role}@${currentIndex}@${currentFormIndex}@${isVisible(active) ? 1 : 0}|${targets.join("|")}`;
  return {
    signature: await sha256Hex(raw),
    hostname,
    frameScope,
    role,
    hints: [...new Set(targets.map((target) => target.split("@", 1)[0] as AutofillFieldRole))]
  };
}

type AutofillControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function deepActiveControl(rootDocument: Document): AutofillControl | undefined {
  let active: Element | null = rootDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const view = rootDocument.defaultView;
  if (!view || !active) return undefined;
  return active instanceof view.HTMLInputElement || active instanceof view.HTMLSelectElement || active instanceof view.HTMLTextAreaElement ? active : undefined;
}

function fieldRole(control: AutofillControl, rootDocument: Document): AutofillFieldRole | undefined {
  const view = rootDocument.defaultView;
  if (!view) return undefined;
  if (control instanceof view.HTMLInputElement) {
    const role = loginFieldRole(control, rootDocument);
    if (role !== "other") return role;
  }
  return walletFieldName(control) ? "wallet" : undefined;
}

function isVisible(control: AutofillControl): boolean {
  const view = control.ownerDocument.defaultView;
  const style = view?.getComputedStyle(control);
  const rect = control.getBoundingClientRect();
  return !control.disabled
    && !(control instanceof control.ownerDocument.defaultView!.HTMLInputElement && control.readOnly)
    && !(control instanceof control.ownerDocument.defaultView!.HTMLTextAreaElement && control.readOnly)
    && style?.display !== "none"
    && style?.visibility !== "hidden"
    && rect.width > 0
    && rect.height > 0;
}

function isTopLevel(rootDocument: Document): boolean {
  try { return rootDocument.defaultView?.top === rootDocument.defaultView; }
  catch { return false; }
}

function boundedIndex(index: number): number {
  if (index < 0) return -1;
  return Math.min(index, MAX_STRUCTURAL_CONTROLS);
}

function normalizeHostname(value: string): string {
  try { return new URL(`https://${value.toLowerCase().replace(/\.+$/, "")}`).hostname; }
  catch { return ""; }
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // HTTP 页面不是安全上下文，crypto.subtle 不存在；回退到纯 JS SHA-256。
  const digest = subtle
    ? await subtle.digest("SHA-256", new TextEncoder().encode(value))
    : sha256Fallback(new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Fallback(input: Uint8Array): ArrayBuffer {
  const message = new Uint8Array(input);
  const bitLength = message.length * 8;
  const paddedLength = ((message.length + 8) >> 6 << 6) + 64;
  const data = new Uint8Array(paddedLength);
  data.set(message);
  data[message.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) => outView.setUint32(index * 4, value, false));
  return out.buffer;
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
