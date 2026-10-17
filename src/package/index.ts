// Owned by Languages. Customization packages: a .zip (project.xml plus files at
// their AppRelativePath) or a bare project.xml. See INTERFACES.md "Zip reader"
// and DECISIONS.md D16.
import type { FileKind, PackageEntry, PackageReader, PackageSource } from '../types';
import { decodeText, kindByExtension, looksLikeZip, normalizePath, readDirectory, readEntry, readHead, ZipError, type ZipRecord } from './zip';

export { ZipError } from './zip';

/** What the project indexer's worker needs to read a zip itself. */
export interface ZipHandle {
  blob: Blob;
  records: ZipRecord[];
  /** Entry kinds by path (after the MZ check). */
  kinds: Record<string, FileKind>;
}

const handles = new WeakMap<PackageSource, ZipHandle>();

/** The Blob and directory behind a source made by createPackageReader (null for xml or foreign sources). */
export function zipHandleOf(source: PackageSource): ZipHandle | null {
  return handles.get(source) ?? null;
}

const PROJECT_XML = 'project.xml';
/** More assemblies than this skip the MZ sniff (kept by extension) to keep open() fast. */
const MZ_CHECK_LIMIT = 64;

/** Case-insensitive, `\` → `/` key used to match AppRelativePath against zip paths. */
export const pathKey = (p: string): string => normalizePath(p).toLowerCase();

async function openZip(file: Blob, name: string): Promise<PackageSource> {
  const records = (await readDirectory(file)).filter((r) => !r.path.endsWith('/'));
  const byKey = new Map(records.map((r) => [pathKey(r.path), r]));
  const projectRec = byKey.get(PROJECT_XML);
  const others = records.filter((r) => r !== projectRec);

  const kinds: Record<string, FileKind> = {};
  const asm = others.filter((r) => kindByExtension(r.path) === 'assembly');
  for (const r of others) kinds[r.path] = kindByExtension(r.path);
  if (asm.length <= MZ_CHECK_LIMIT) {
    await Promise.all(
      asm.map(async (r) => {
        const head = r.size >= 2 ? await readHead(file, r, 2).catch(() => new Uint8Array()) : new Uint8Array();
        if (!(head[0] === 0x4d && head[1] === 0x5a)) kinds[r.path] = 'binary';
      }),
    );
  }

  const entries: PackageEntry[] = others.map((r) => ({ path: r.path, size: r.size, compressedSize: r.compressedSize, kind: kinds[r.path] ?? 'binary' }));
  const projectXml = projectRec ? decodeText(await readEntry(file, projectRec)) : null;

  const find = (path: string): ZipRecord => {
    const r = byKey.get(pathKey(path));
    if (!r) throw new ZipError(`"${path}" is not in ${name}.`);
    return r;
  };
  const source: PackageSource = {
    name,
    kind: 'zip',
    bytes: file.size,
    projectXml,
    entries,
    read: async (path) => readEntry(file, find(path)),
    readText: async (path) => decodeText(await readEntry(file, find(path))),
  };
  handles.set(source, { blob: file, records: others, kinds });
  return source;
}

async function openXml(file: Blob, name: string): Promise<PackageSource> {
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  const none = (path: string): Promise<never> => Promise.reject(new ZipError(`"${path}" is not in ${name} (a bare project.xml has no files).`));
  return { name, kind: 'xml', bytes: file.size, projectXml: text, entries: [], read: none, readText: none };
}

export function createPackageReader(): PackageReader {
  return {
    async open(file, name) {
      if (await looksLikeZip(file)) return openZip(file, name);
      if (/\.zip$/i.test(name)) throw new ZipError(`${name} is not a zip archive (it does not start with a zip header).`);
      return openXml(file, name);
    },
  };
}
