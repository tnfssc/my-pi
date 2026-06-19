import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

const SNIPPET_THRESHOLD_BYTES = 50 * 1024;
const PATCH_FLAG = "__piLargePasteSnippetFileFullPatched";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizePastedText(editor: Editor, pastedText: string): string {
  const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
    const cp = Number(code);
    if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
    return match;
  });

  const normalized = (editor as unknown as { normalizeText?: (text: string) => string }).normalizeText?.(decodedText)
    ?? decodedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");

  return normalized
    .split("")
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
}

function writeSnippetFile(text: string): string {
  const dir = path.join(os.tmpdir(), "pi-snippets");
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `pi-paste-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

export default function (_pi: ExtensionAPI) {
  const proto = Editor.prototype as typeof Editor.prototype & Record<string, unknown>;
  if (proto[PATCH_FLAG]) return;

  const originalHandlePaste = proto.handlePaste as (this: Editor, pastedText: string) => void;

  proto.handlePaste = function patchedHandlePaste(this: Editor, pastedText: string) {
    const normalized = normalizePastedText(this, pastedText);

    if (byteLength(normalized) > SNIPPET_THRESHOLD_BYTES) {
      const filePath = writeSnippetFile(normalized);
      return originalHandlePaste.call(this, filePath);
    }

    return originalHandlePaste.call(this, pastedText);
  } as typeof originalHandlePaste;

  proto[PATCH_FLAG] = true;
}
