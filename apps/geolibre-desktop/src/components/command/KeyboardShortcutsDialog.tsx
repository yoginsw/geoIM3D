import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type Command,
  type Shortcut,
  PALETTE_SHORTCUT,
  SHORTCUTS_HELP_SHORTCUT,
  formatShortcut,
  isMacPlatform,
} from "../../lib/commands";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  commands: Command[];
  onOpenChange: (open: boolean) => void;
}

interface ShortcutRow {
  id: string;
  label: string;
  /** A command-style shortcut, formatted per platform. */
  shortcut?: Shortcut;
  /** A pre-rendered key label, for keys handled natively by MapLibre. */
  display?: string;
}

/**
 * A cheat sheet (opened with `?`) listing every global keyboard shortcut,
 * grouped the same way as the command palette.
 */
export function KeyboardShortcutsDialog({
  open,
  commands,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation();
  const isMac = useMemo(() => isMacPlatform(), []);

  const groups = useMemo(() => {
    const ordered: Array<{ group: string; rows: ShortcutRow[] }> = [];
    const indexByGroup = new Map<string, number>();
    const pushRow = (group: string, row: ShortcutRow) => {
      let position = indexByGroup.get(group);
      if (position === undefined) {
        position = ordered.length;
        indexByGroup.set(group, position);
        ordered.push({ group, rows: [] });
      }
      ordered[position].rows.push(row);
    };

    // The palette and cheat-sheet shortcuts are not commands, so list them
    // first under a "General" group.
    pushRow(t("common.general"), {
      id: "general.open-command-palette",
      label: t("common.openCommandPalette"),
      shortcut: PALETTE_SHORTCUT,
    });
    pushRow(t("common.general"), {
      id: "general.show-keyboard-shortcuts",
      label: t("common.showKeyboardShortcuts"),
      shortcut: SHORTCUTS_HELP_SHORTCUT,
    });

    for (const command of commands) {
      if (command.shortcut) {
        pushRow(command.group, {
          id: command.id,
          label: command.title,
          shortcut: command.shortcut,
        });
      }
    }

    // MapLibre-native navigation keys are not commands. List them as the final,
    // display-only group; they work only while the map canvas has focus.
    const mapNavigationRows: ShortcutRow[] = [
      { id: "nav.zoom-in", label: t("common.zoomIn"), display: "+" },
      { id: "nav.zoom-out", label: t("common.zoomOut"), display: "−" },
      { id: "nav.pan", label: t("common.pan"), display: "← ↑ ↓ →" },
      { id: "nav.rotate", label: t("common.rotate"), display: "⇧ ← / →" },
      { id: "nav.tilt", label: t("common.tilt"), display: "⇧ ↑ / ↓" },
    ];
    for (const row of mapNavigationRows) {
      pushRow(t("common.mapNavigation"), row);
    }
    return ordered;
  }, [commands, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("common.keyboardShortcuts")}</DialogTitle>
          <DialogDescription>
            {t("common.keyboardShortcutsDescription", {
              shortcut: formatShortcut(PALETTE_SHORTCUT, isMac),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {groups.map(({ group, rows }) => (
            <div key={group} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {group}
              </p>
              <ul className="space-y-1">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="min-w-0 truncate">{row.label}</span>
                    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {row.shortcut
                        ? formatShortcut(row.shortcut, isMac)
                        : row.display}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
