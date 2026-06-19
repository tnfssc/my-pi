import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatContextUsage, formatCost, formatCwd, linkText, sanitizeText } from "../utils/format";
import { getEntryUsage } from "../utils/usage";

import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";

let footerData: ReadonlyFooterDataProvider | undefined;

export function setSparkFooterData(data: ReadonlyFooterDataProvider | undefined): void {
  footerData = data;
}

export function renderSparkStatus(ctx: ExtensionContext, theme: Theme): string {
  const left = renderSparkStatusLeft(ctx, theme);
  const right = renderSparkStatusRight(ctx, theme);
  return [left, right].filter(Boolean).join(theme.fg("dim", " • "));
}

export function renderSparkStatusLeft(ctx: ExtensionContext, theme: Theme): string {
  return getLeft(ctx, theme);
}

export function renderSparkStatusRight(ctx: ExtensionContext, theme: Theme): string {
  return getRight(ctx, theme);
}

function getLeft(ctx: ExtensionContext, theme: Theme): string {
  const cwd = ctx.sessionManager.getCwd();
  const url = pathToFileURL(resolve(cwd));
  const cwdText = linkText(formatCwd(cwd, homedir()), url.href);
  const rawBranch = footerData?.getGitBranch();
  const branch = rawBranch && rawBranch !== basename(resolve(cwd)) ? rawBranch : undefined;
  const sessionName = ctx.sessionManager.getSessionName();

  return theme.fg("dim", [cwdText, branch, sessionName].filter(Boolean).join(" • "));
}

function getRight(ctx: ExtensionContext, theme: Theme): string {
  const statusesText = getStatusesText(theme);
  const styledCostText = getStyledCostText(ctx, theme);
  const styledContextUsageText = getStyledContextUsageText(ctx, theme);

  return [statusesText, styledCostText, styledContextUsageText].filter(Boolean).join(theme.fg("dim", " • "));
}

function getStatusesText(theme: Theme): string {
  const extensionStatuses = footerData?.getExtensionStatuses();
  if (!extensionStatuses || extensionStatuses.size === 0) return "";

  return Array.from(extensionStatuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeText(text))
    .join(theme.fg("dim", " • "));
}

function getStyledCostText(ctx: ExtensionContext, theme: Theme): string {
  const totalCost = ctx.sessionManager.getBranch().reduce((acc, entry) => acc + (getEntryUsage(entry)?.cost.total ?? 0), 0);
  const costText = formatCost(totalCost);

  if (totalCost > 20) return theme.fg("warning", costText);
  return theme.fg("dim", costText);
}

function getStyledContextUsageText(ctx: ExtensionContext, theme: Theme): string {
  const contextUsage = ctx.getContextUsage();
  const contextUsageText = formatContextUsage(contextUsage);
  const percent = contextUsage?.percent ?? null;

  if (percent && percent > 90) return theme.fg("error", contextUsageText);
  if (percent && percent > 70) return theme.fg("warning", contextUsageText);
  return theme.fg("dim", contextUsageText);
}
