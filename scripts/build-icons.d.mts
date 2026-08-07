export interface DesktopIcon { svg: string; label: string }
export function iconsFromLanding(html: string): Record<string, DesktopIcon>;
export function renderIcons(icons: Record<string, DesktopIcon>): string;
export function buildIcons(): { text: string; count: number };
