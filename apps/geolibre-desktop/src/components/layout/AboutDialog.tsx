import {
  Button,
  type ButtonProps,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@geolibre/ui";
import { ExternalLink, Info, Map } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BRAND } from "../../config/brand";
import { openExternalLink } from "../../lib/open-external";

const LINKS = [
  {
    labelKey: "about.homePage",
    href: BRAND.website,
  },
  {
    labelKey: "about.githubRepository",
    href: BRAND.upstream.url,
  },
] as const;

interface AboutDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  renderTrigger?: boolean;
  buttonClassName?: string;
  buttonSize?: ButtonProps["size"];
  iconClassName?: string;
  showLabels?: boolean;
}

export function AboutDialog({
  open,
  onOpenChange,
  renderTrigger = true,
  buttonClassName,
  buttonSize = "sm",
  iconClassName,
  showLabels = true,
}: AboutDialogProps) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const dialogOpen = open ?? internalOpen;

  const handleOpenChange = (nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      {renderTrigger ? (
        <DialogTrigger asChild>
          <Button
            className={buttonClassName}
            variant="ghost"
            size={buttonSize}
            aria-label={t("about.trigger")}
          >
            <Info className={iconClassName ?? "h-3.5 w-3.5 sm:me-1"} />
            {showLabels ? (
              <span className="hidden sm:inline">{t("about.trigger")}</span>
            ) : null}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Map className="h-5 w-5 text-primary" />
            {t("about.title")}
          </DialogTitle>
          <DialogDescription>{t("about.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-muted-foreground">{t("about.version")}</span>
            <span className="font-mono text-foreground">
              {BRAND.productName} {BRAND.version}
            </span>
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div>{BRAND.copyright}</div>
            <div>
              {t("about.upstreamNotice", {
                name: BRAND.upstream.name,
                license: BRAND.upstream.license,
              })}
            </div>
          </div>
          <div className="space-y-2 border-t pt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("about.generalSectionTitle")}
            </div>
            {LINKS.map((link) => (
              <a
                key={link.href}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                href={link.href}
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(link.href);
                }}
                rel="noreferrer"
                target="_blank"
              >
                <span>{t(link.labelKey)}</span>
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  {link.href.replace(/^https?:\/\//, "")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </span>
              </a>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
