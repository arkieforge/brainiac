// The rename the daemon needs and POSIX rename(2) doesn't give: swap two paths in one step, so a save racing a
// sync write is displaced instead of overwritten. Called through bun:ffi: renamex_np on macOS, renameat2 on
// Linux. Windows (ReplaceFileW) comes with its daemon (#28). A new file needs no swap: link(2) refuses to replace.
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

/** done; one of the paths is gone; the filesystem can't do it. */
export type Outcome = "done" | "missing" | "unsupported";

interface Native {
  rename(from: Buffer, to: Buffer, flags: number): number;
  errno(): number;
  readonly exchange: number;
  /** errno values meaning the filesystem or kernel lacks the call. */
  readonly unsupported: readonly number[];
}

const ENOENT = 2;

/** The platform's call, or undefined where it can't be loaded (another libc, another OS): no swap then. */
function load(): Native | undefined {
  try {
    return open();
  } catch {
    return undefined;
  }
}

function open(): Native | undefined {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    return {
      rename: (from, to, flags) => symbols.renamex_np(from, to, flags),
      errno: () => read.i32(symbols["__error"]() as Pointer, 0),
      exchange: 0x2, // RENAME_SWAP
      unsupported: [22, 45, 78], // EINVAL, ENOTSUP, ENOSYS
    };
  }
  if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      renameat2: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    const AT_FDCWD = -100;
    return {
      rename: (from, to, flags) => symbols.renameat2(AT_FDCWD, from, AT_FDCWD, to, flags),
      errno: () => read.i32(symbols["__errno_location"]() as Pointer, 0),
      exchange: 2, // RENAME_EXCHANGE
      unsupported: [22, 38, 95], // EINVAL, ENOSYS, EOPNOTSUPP
    };
  }
  return undefined;
}

let native: Native | undefined | null = null;

const cString = (path: string) => Buffer.from(`${path}\0`);

/** Exchanges two existing paths in one step: each name ends up with the other's file. */
export function exchange(a: string, b: string): Outcome {
  if (native === null) native = load();
  if (!native) return "unsupported";
  if (native.rename(cString(a), cString(b), native.exchange) === 0) return "done";
  const errno = native.errno();
  if (errno === ENOENT) return "missing";
  if (native.unsupported.includes(errno)) return "unsupported";
  throw new Error(`swapping ${a} and ${b} failed with errno ${errno}`);
}
