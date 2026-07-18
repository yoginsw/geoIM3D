import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import {
  Bug,
  CircleHelp,
  FolderGit2,
  Globe,
  Info,
  Keyboard,
  MessageSquare,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import {
  FEEDBACK_URL,
  GITHUB_URL,
  openExternalLink,
  type ToolbarChrome,
  WEBSITE_URL,
} from "./constants";

interface HelpMenuProps {
  chrome: ToolbarChrome;
  diagnosticsErrorCount: number;
  onOpenCommandPalette: () => void;
  onOpenShortcuts: () => void;
  onOpenDiagnostics: () => void;
  onAbout: () => void;
}

/** The Help menu: command palette, shortcuts, diagnostics, feedback, and about. */
export function HelpMenu({
  chrome,
  diagnosticsErrorCount,
  onOpenCommandPalette,
  onOpenShortcuts,
  onOpenDiagnostics,
  onAbout,
}: HelpMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.help")}
        >
          <CircleHelp className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.help"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.menu.help")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {show("help.commandPalette") && (
          <DropdownMenuItem onSelect={onOpenCommandPalette}>
            <Search className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.commandPalette")}
          </DropdownMenuItem>
        )}
        {show("help.keyboardShortcuts") && (
          <DropdownMenuItem onSelect={onOpenShortcuts}>
            <Keyboard className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.keyboardShortcuts")}
          </DropdownMenuItem>
        )}
        {(show("help.commandPalette") || show("help.keyboardShortcuts")) && (
          <DropdownMenuSeparator />
        )}
        {show("help.website") && (
          <DropdownMenuItem onSelect={() => void openExternalLink(WEBSITE_URL)}>
            <Globe className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.website")}
          </DropdownMenuItem>
        )}
        {show("help.github") && (
          <DropdownMenuItem onSelect={() => void openExternalLink(GITHUB_URL)}>
            <FolderGit2 className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.githubRepository")}
          </DropdownMenuItem>
        )}
        {(show("help.website") || show("help.github")) &&
          (show("help.diagnostics") ||
            show("help.feedback") ||
            show("help.about")) && <DropdownMenuSeparator />}
        {show("help.diagnostics") && (
          <DropdownMenuItem onSelect={onOpenDiagnostics}>
            <Bug className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.diagnostics")}
            {diagnosticsErrorCount > 0 ? (
              <span className="ms-2 rounded bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
                {diagnosticsErrorCount}
              </span>
            ) : null}
          </DropdownMenuItem>
        )}
        {show("help.feedback") && (
          <DropdownMenuItem onSelect={() => void openExternalLink(FEEDBACK_URL)}>
            <MessageSquare className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.giveFeedback")}
          </DropdownMenuItem>
        )}
        {show("help.about") && (
          <DropdownMenuItem onSelect={onAbout}>
            <Info className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.about")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
