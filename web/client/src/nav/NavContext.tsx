import { createContext, useContext, type ReactNode } from "react";

export type NavTarget =
  | { kind: "artist"; id: string; name: string }
  | { kind: "album"; id: string; title: string; artist: string };

export interface NavActions {
  openArtist: (artist: { id?: string; name: string }) => void;
  openAlbum: (album: { id?: string; title: string; artist: string }) => void;
  back: () => void;
}

const NavCtx = createContext<NavActions>({
  openArtist: () => undefined,
  openAlbum: () => undefined,
  back: () => undefined,
});

export function NavProvider({ value, children }: { value: NavActions; children: ReactNode }) {
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>;
}

export function useNav(): NavActions {
  return useContext(NavCtx);
}
