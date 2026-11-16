import {
  Fingerprint,
  House,
  List,
  MagnifyingGlass,
  Question,
  SealCheck,
  Tray,
  UserCircle,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import { Toaster } from "@yusufceng1z/ding-react";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { PipDetectiveSticker } from "stick-it-up";
import { Drawer } from "vaul";

import { BASE, calm, SPRING } from "../motion.ts";
import { notesOf, start, useRecord, type Status } from "../record.ts";
import { Files } from "./Files.tsx";
import { Palette } from "./Palette.tsx";
import { Pip } from "./Pip.tsx";
import { Tree } from "./Tree.tsx";

const STATUS: Record<Status, string> = {
  loading: "Loading…",
  connecting: "Connecting…",
  live: "Live",
  offline: "Offline: showing this device's copy",
  "signed-out": "Signed out",
};

const NAV: readonly {
  readonly to: "/" | "/review" | "/questions" | "/proposals" | "/approvals";
  readonly label: string;
  readonly icon: Icon;
}[] = [
  { to: "/", label: "Overview", icon: House },
  { to: "/review", label: "Review", icon: SealCheck },
  { to: "/questions", label: "Questions", icon: Question },
  { to: "/proposals", label: "Proposals", icon: Tray },
  { to: "/approvals", label: "Approvals", icon: Fingerprint },
];

// Matches the phone breakpoint in styles.css. The prerendered shell has no window, so it renders the desktop side.
const PHONE = "(max-width: 760px)";
const onPhoneChange = (listener: () => void) => {
  const query = matchMedia(PHONE);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const usePhone = () =>
  useSyncExternalStore(
    onPhoneChange,
    () => matchMedia(PHONE).matches,
    () => false,
  );

/** The ⌘K button leans a few pixels toward the cursor and springs home when it leaves. */
function FindButton({ onOpen }: { readonly onOpen: () => void }) {
  const x = useSpring(useMotionValue(0), SPRING);
  const y = useSpring(useMotionValue(0), SPRING);
  const still = useReducedMotion();
  const lean = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "mouse" || still) return;
    const box = event.currentTarget.getBoundingClientRect();
    x.set(((event.clientX - box.left) / box.width - 0.5) * 8);
    y.set(((event.clientY - box.top) / box.height - 0.5) * 5);
  };
  return (
    <motion.button
      type="button"
      className="find"
      aria-label="Go to a note"
      style={{ x, y }}
      onPointerMove={lean}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
      onClick={onOpen}
    >
      <MagnifyingGlass size={14} />
      <span className="find-label">Go to a note</span>
      <kbd>⌘K</kbd>
    </motion.button>
  );
}

/** The site's frame: a bar, the record's tree and files beside the open pane (a drawer on phones). */
export function Shell({
  noteId,
  fileId,
  children,
}: {
  readonly noteId?: string;
  readonly fileId?: string;
  readonly children: ReactNode;
}) {
  const { status, client, files } = useRecord();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const phone = usePhone();
  const pathname = useLocation({ select: (location) => location.pathname });
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => void start(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setPalette((open) => !open);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // The Live dot pings once when the record brings a version this tab wasn't already showing (another device, or a
  // save that went straight to the record, like a review Correct): sync made visible, without a loop. Typing
  // changes this tab's working copy first, so the record confirming it is nothing new and doesn't ping.
  useEffect(() => {
    if (!client) return;
    const shown = new Map([...client.state.remote.keys()].map((id) => [id, client.working(id)]));
    return client.subscribe((ids) => {
      let arrived = false;
      for (const id of ids) {
        const remote = client.state.remote.get(id);
        if (remote && remote.raw !== shown.get(id)) arrived = arrived || client.working(id) === remote.raw;
        shown.set(id, client.working(id));
      }
      if (!arrived || calm()) return;
      dot.current?.animate(
        [
          { transform: "scale(1)", opacity: 0.7 },
          { transform: "scale(3.2)", opacity: 0 },
        ],
        { duration: 900, easing: "cubic-bezier(0.23, 1, 0.32, 1)", pseudoElement: "::after" },
      );
    });
  }, [client]);
  if (status === "signed-out")
    return (
      <div className="empty signed-out">
        <Pip sticker="thinking" say="Sign in to see your record." />
        <a href={`/sign-in?next=${encodeURIComponent(location.pathname)}`}>Sign in</a>
      </div>
    );
  const side = (
    <>
      <Tree notes={notesOf(client)} selected={noteId} onOpen={() => setDrawer(false)} />
      <Files files={files} selected={fileId} onOpen={() => setDrawer(false)} />
    </>
  );
  return (
    <MotionConfig reducedMotion="user" transition={BASE}>
      <div className="app">
        <header className="bar">
          <button
            type="button"
            className="drawer-toggle ghost"
            aria-expanded={drawer}
            aria-label={drawer ? "Close your notes" : "Your notes"}
            onClick={() => setDrawer(!drawer)}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={drawer ? "close" : "open"}
                initial={{ opacity: 0, rotate: -45, scale: 0.6 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 45, scale: 0.6 }}
                className="flex"
              >
                {drawer ? <X size={18} /> : <List size={18} />}
              </motion.span>
            </AnimatePresence>
          </button>
          <Link to="/" className="brand" aria-label="Brainiac, your record">
            <PipDetectiveSticker size={26} aria-hidden className="brand-pip" />
            <span className="brand-name">Brainiac</span>
          </Link>
          <nav>
            {NAV.map(({ to, label, icon: Nav }) => {
              const here = pathname === to || (to !== "/" && pathname.startsWith(`${to}/`));
              return (
                <Link key={to} to={to} aria-current={here ? "page" : undefined} aria-label={label}>
                  {here && <motion.span layoutId="nav-pill" className="nav-pill" transition={SPRING} />}
                  <Nav size={15} weight={here ? "fill" : "regular"} />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>
          <FindButton onOpen={() => setPalette(true)} />
          <span className="status" data-status={status}>
            <span className="dot" ref={dot} />
            {STATUS[status]}
          </span>
          <a href="/account" className="account" aria-label="Account">
            <UserCircle size={20} weight="duotone" />
          </a>
        </header>
        {phone ? (
          <Drawer.Root open={drawer} onOpenChange={setDrawer} direction="left">
            <Drawer.Portal>
              <Drawer.Overlay className="drawer-overlay" />
              <Drawer.Content className="drawer" aria-describedby={undefined}>
                <Drawer.Title className="sr-only">Your notes</Drawer.Title>
                {side}
              </Drawer.Content>
            </Drawer.Portal>
          </Drawer.Root>
        ) : (
          <aside className="side">{side}</aside>
        )}
        <main className="main">{children}</main>
        <Palette open={palette} onOpenChange={setPalette} />
        <Toaster position="bottom-center" theme="dark" />
      </div>
    </MotionConfig>
  );
}
