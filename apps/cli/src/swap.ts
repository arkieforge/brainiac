// The rename the daemon needs and POSIX rename(2) doesn't give: swap two paths in one step, so a save racing a
// sync write is displaced instead of overwritten. Called through bun:ffi: renamex_np on macOS, renameat2 on
// Linux, ReplaceFileW with a backup name on Windows. A new file needs no swap: link(2) refuses to replace.
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

/** done; one of the paths is gone; the filesystem can't do it (or, on Windows, a program has the file locked). */
export type Outcome = "done" | "missing" | "unsupported";

type Swap = (a: string, b: string, spare: string) => Outcome;

const ENOENT = 2;

const cString = (path: string) => Buffer.from(`${path}\0`);
/** A path as Windows' wide-character calls take it. */
const wide = (path: string) => Buffer.from(`${path}\0`, "utf16le");

/** The platform's call, or undefined where it can't be loaded (another libc, another OS): no swap then. */
function load(): Swap | undefined {
  try {
    return process.platform === "win32" ? windows() : posix();
  } catch {
    return undefined;
  }
}

function posix(): Swap | undefined {
  let call: { rename(from: Buffer, to: Buffer): number; errno(): number; unsupported: readonly number[] };
  if (process.platform === "darwin") {
    const { symbols } = dlopen("libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    call = {
      rename: (from, to) => symbols.renamex_np(from, to, 0x2), // RENAME_SWAP
      errno: () => read.i32(symbols["__error"]() as Pointer, 0),
      unsupported: [22, 45, 78], // EINVAL, ENOTSUP, ENOSYS
    };
  } else if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      renameat2: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    const AT_FDCWD = -100;
    call = {
      rename: (from, to) => symbols.renameat2(AT_FDCWD, from, AT_FDCWD, to, 2), // RENAME_EXCHANGE
      errno: () => read.i32(symbols["__errno_location"]() as Pointer, 0),
      unsupported: [22, 38, 95], // EINVAL, ENOSYS, EOPNOTSUPP
    };
  } else return undefined;
  return (a, b) => {
    if (call.rename(cString(a), cString(b)) === 0) return "done";
    const errno = call.errno();
    if (errno === ENOENT) return "missing";
    if (call.unsupported.includes(errno)) return "unsupported";
    throw new Error(`swapping ${a} and ${b} failed with errno ${errno}`);
  };
}

/**
 * ReplaceFileW puts a's file at b and moves b's file, as one file object (so an editor's open handle follows
 * it), to the backup name `spare`; a's name is free then, and the displaced file takes it. Not one step: a
 * crash between the two leaves the displaced file at `spare`, a temp name the daemon recovers on its next start.
 */
function windows(): Swap {
  const { symbols } = dlopen("kernel32.dll", {
    ReplaceFileW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const move = (from: string, to: string) => symbols.MoveFileExW(wide(from), wide(to), 0) !== 0; // never replaces
  const REPLACEFILE_IGNORE_MERGE_ERRORS = 0x2;
  const REPLACEFILE_IGNORE_ACL_ERRORS = 0x4;
  return (a, b, spare) => {
    const flags = REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS;
    if (symbols.ReplaceFileW(wide(b), wide(a), wide(spare), flags, null, null) !== 0) {
      if (move(spare, a)) return "done";
      throw new Error(
        `moving the displaced ${b} from ${spare} to ${a} failed with error ${symbols.GetLastError()}`,
      );
    }
    const error = symbols.GetLastError();
    if (error === 2 || error === 3) return "missing"; // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND
    // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: b's file went to `spare` but a's didn't take its place. It goes back
    // if its name is still free; if a save took the name meanwhile it stays at `spare`, recovered on the next
    // start, and the save is the watcher's to report.
    if (error === 1177) {
      move(spare, b);
      return "unsupported";
    }
    // shortcut: a file a program holds open without sharing delete (ERROR_SHARING_VIOLATION, ERROR_ACCESS_DENIED,
    // ERROR_UNABLE_TO_REMOVE_REPLACED, ERROR_UNABLE_TO_MOVE_REPLACEMENT: nothing moved) waits like one on a
    // filesystem without the call; retry on the next batch instead if editors that lock files turn out common.
    if ([5, 32, 33, 1175, 1176].includes(error)) return "unsupported";
    throw new Error(`swapping ${a} and ${b} failed with error ${error}`);
  };
}

let native: Swap | undefined | null = null;

/**
 * Exchanges two existing paths in one step: each name ends up with the other's file. `spare` is a free name
 * beside them that Windows moves b's file through on its way to a.
 */
export function exchange(a: string, b: string, spare = `${a}~`): Outcome {
  if (native === null) native = load();
  return native ? native(a, b, spare) : "unsupported";
}
