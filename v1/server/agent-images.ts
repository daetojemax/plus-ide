import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Image } from 'mdast';
import type { Message } from '../shared/protocol';
import type { Store } from './store';

const parser = unified().use(remarkParse);
const limit = 12 * 1024 * 1024;
function inside(path: string, root: string) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

// Import only images explicitly returned in agent Markdown. The browser never supplies
// a filesystem path to a download endpoint; copied images use project-scoped attachment IDs.
export function importAgentImages(store: Store, message: Message): Message {
  if (message.kind !== 'agent' || !message.text.includes('![')) return message;
  const project = store.project(message.projectId);
  if (!project) return message;
  const roots = [project.path, tmpdir(), '/tmp'].flatMap((path) => {
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
  const images: Image[] = [];
  function visit(node: { type: string; children?: (typeof node)[] }) {
    if (node.type === 'image') images.push(node as Image);
    if (node.children) node.children.forEach(visit);
  }
  visit(parser.parse(message.text));
  const attachments = [...message.attachments];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of images.slice(0, 8)) {
    let fd: number | undefined;
    try {
      if (
        node.url.startsWith('/api/attachments/') ||
        /^(?:https?:|data:|blob:|\/\/)/i.test(node.url)
      )
        continue;
      const source = node.url.startsWith('file:')
        ? fileURLToPath(node.url)
        : decodeURIComponent(node.url);
      if (/^[a-z][a-z0-9+.-]*:/i.test(source)) continue;
      const path = realpathSync(resolve(project.path, source));
      if (!roots.some((root) => inside(path, root))) continue;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 12 || stat.size > limit) continue;
      const data = Buffer.alloc(stat.size);
      let bytes = 0;
      while (bytes < data.length) {
        const n = readSync(fd, data, bytes, data.length - bytes, bytes);
        if (!n) break;
        bytes += n;
      }
      if (bytes !== data.length) continue;
      const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : data[0] === 255 && data[1] === 216 && data[2] === 255
          ? 'image/jpeg'
          : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
            ? 'image/webp'
            : null;
      if (!mime) continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const attachment = {
        id: randomUUID(),
        name: basename(path),
        mime,
        size: data.length,
        inline: true,
      };
      writeFileSync(join(store.directory, 'attachments', attachment.id), data, { mode: 0o600 });
      store.addAttachment(project.id, 'agent', attachment);
      attachments.push(attachment);
      const alt = (node.alt || attachment.name).replace(/[\[\]\\]/g, '\\$&');
      edits.push({ start, end, text: `![${alt}](/api/attachments/${attachment.id})` });
    } catch {
      // Missing or unsupported files must not discard the agent's text response.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (!edits.length) return message;
  let text = message.text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { ...message, text, attachments };
}
