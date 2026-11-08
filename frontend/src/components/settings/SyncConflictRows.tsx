import { Button } from "@/components/ui/button";
import type { SyncConflict, SyncConflictResolution } from "@/lib/bridge";
import { formatSyncWall } from "./syncFormat";

const VALUE_LIMIT = 80;

function truncate(value: string): string {
  return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT - 1)}…` : value;
}

/** Objects and long strings stay compact so two values fit side by side. */
function formatConflictValue(value: unknown): string {
  if (value === null || value === undefined) return "Empty";
  if (typeof value === "string") return value.length === 0 ? "Empty" : truncate(value);
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json && json !== "{}" ? truncate(json) : "Empty";
  }
  return truncate(String(value));
}

/** The full value behind a truncated row, for hover text. */
function fullValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? undefined;
}

function objectFieldCount(value: unknown): number | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : null;
}

function deviceLabel(name: string, id: string, deviceId: string | null): string {
  return deviceId && id === deviceId ? `${name} (this device)` : name;
}

type ConflictChoice = {
  thisDevice: SyncConflictResolution;
  other: SyncConflictResolution;
  thisLabel: string;
  otherLabel: string;
};

/**
 * The applied winner is not always the local value. A local winner means
 * "Keep this device" keeps the winner; a local loser means it republishes the
 * loser. The opposite button always takes the opposite action.
 */
function conflictChoices(conflict: SyncConflict, deviceId: string | null): ConflictChoice {
  const winnerLocal = Boolean(deviceId) && conflict.winnerDeviceId === deviceId;
  const loserLocal = Boolean(deviceId) && conflict.loserDeviceId === deviceId;
  const relative = winnerLocal || loserLocal;
  const thisDevice: SyncConflictResolution =
    loserLocal && !winnerLocal ? "apply_loser" : "keep_winner";
  return {
    thisDevice,
    other: thisDevice === "keep_winner" ? "apply_loser" : "keep_winner",
    thisLabel: relative ? "Keep this device" : "Keep winner",
    otherLabel: relative ? "Keep other" : "Apply other",
  };
}

function fieldPriority(field: string): number {
  if (field === "__deleted__" || field === "__restore__") return 0;
  if (field === "__entity__") return 1;
  return 2;
}

/** Delete/edit rows lead, then whole entities, then plain fields; newest first. */
export function compareConflicts(left: SyncConflict, right: SyncConflict): number {
  const priority = fieldPriority(left.field) - fieldPriority(right.field);
  if (priority !== 0) return priority;
  if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt);
  return right.id - left.id;
}

export type ConflictGroup = {
  key: string;
  title: string;
  author: string | null;
  rows: SyncConflict[];
};

export function groupConflicts(conflicts: SyncConflict[]): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();
  for (const conflict of [...conflicts].sort(compareConflicts)) {
    const key = conflict.bookUid ?? `title:${conflict.bookTitle ?? "unknown"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: conflict.bookTitle ?? "Unknown book",
        author: conflict.bookAuthor,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(conflict);
  }
  return [...groups.values()];
}

function blockedReasonFor(conflict: SyncConflict): string {
  return conflict.applyLoserBlockedReason ?? "The other value cannot be applied.";
}

function ConflictValue({ value }: { value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <p className="mt-1 break-words text-muted-foreground">Empty</p>;
    }
    return (
      <ul className="mt-1 flex flex-col gap-0.5">
        {entries.map(([key, item]) => (
          <li key={key} className="break-words">
            <span className="font-medium text-muted-foreground">{key}:</span>{" "}
            {formatConflictValue(item)}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="mt-1 break-words">{formatConflictValue(value)}</p>;
}

function ConflictRow({
  conflict,
  deviceId,
  busy,
  idPrefix,
  onResolve,
  onLater,
}: {
  conflict: SyncConflict;
  deviceId: string | null;
  busy: boolean;
  idPrefix: string;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onLater: (id: number) => void;
}) {
  const choices = conflictChoices(conflict, deviceId);
  const isDelete = conflict.field === "__deleted__";
  const isRestore = conflict.field === "__restore__";
  const isTombstone = isDelete || isRestore;
  const fieldLabel = conflict.fieldLabel ?? conflict.field.replaceAll("_", " ");
  const editFieldCount = isTombstone ? objectFieldCount(conflict.loser) : null;
  const editLabel = isRestore ? "Restored" : "Edited";
  const blocked = !conflict.canApplyLoser;
  const blockedId = `sync-conflict-${idPrefix}-${conflict.id}-blocked`;

  return (
    <li data-testid={`sync-conflict-${conflict.id}`} className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{fieldLabel}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {conflict.kind.replaceAll("_", " ")}
          </p>
        </div>
        <ConflictActions
          conflict={conflict}
          choices={choices}
          blocked={blocked}
          busy={busy}
          blockedId={blockedId}
          onResolve={onResolve}
          onLater={onLater}
        />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ConflictKeptPanel conflict={conflict} deviceId={deviceId} />
        <ConflictDiscardedPanel
          conflict={conflict}
          deviceId={deviceId}
          isTombstone={isTombstone}
          editLabel={editLabel}
          editFieldCount={editFieldCount}
        />
      </div>

      {blocked ? (
        <p
          id={blockedId}
          data-testid={`sync-conflict-${conflict.id}-blocked`}
          className="mt-2 text-xs text-muted-foreground"
        >
          {blockedReasonFor(conflict)}
        </p>
      ) : null}
    </li>
  );
}

function ConflictActions({
  conflict,
  choices,
  blocked,
  busy,
  blockedId,
  onResolve,
  onLater,
}: {
  conflict: SyncConflict;
  choices: ConflictChoice;
  blocked: boolean;
  busy: boolean;
  blockedId: string;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onLater: (id: number) => void;
}) {
  const thisDisabled = busy || (blocked && choices.thisDevice === "apply_loser");
  const otherDisabled = busy || (blocked && choices.other === "apply_loser");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        data-testid={`sync-conflict-${conflict.id}-this-device`}
        onClick={() => onResolve(conflict.id, choices.thisDevice)}
        disabled={thisDisabled}
        aria-describedby={blocked && choices.thisDevice === "apply_loser" ? blockedId : undefined}
      >
        {choices.thisLabel}
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid={`sync-conflict-${conflict.id}-other`}
        onClick={() => onResolve(conflict.id, choices.other)}
        disabled={otherDisabled}
        title={otherDisabled && blocked ? blockedReasonFor(conflict) : undefined}
        aria-describedby={blocked && choices.other === "apply_loser" ? blockedId : undefined}
      >
        {choices.otherLabel}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`sync-conflict-${conflict.id}-later`}
        onClick={() => onLater(conflict.id)}
        disabled={busy}
      >
        Decide later
      </Button>
    </div>
  );
}

function ConflictKeptPanel({
  conflict,
  deviceId,
}: {
  conflict: SyncConflict;
  deviceId: string | null;
}) {
  return (
    <div
      data-testid={`sync-conflict-${conflict.id}-kept`}
      title={fullValue(conflict.winner)}
      className="rounded-md bg-muted/40 p-2"
    >
      <p className="text-xs font-medium text-muted-foreground">Currently kept</p>
      {conflict.winner === "deleted" ? (
        <p className="mt-1 break-words">Deleted</p>
      ) : (
        <ConflictValue value={conflict.winner} />
      )}
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {deviceLabel(conflict.winnerDeviceName, conflict.winnerDeviceId, deviceId)} ·{" "}
        {formatSyncWall(conflict.winnerWall)}
      </p>
    </div>
  );
}

function ConflictDiscardedPanel({
  conflict,
  deviceId,
  isTombstone,
  editLabel,
  editFieldCount,
}: {
  conflict: SyncConflict;
  deviceId: string | null;
  isTombstone: boolean;
  editLabel: string;
  editFieldCount: number | null;
}) {
  return (
    <div
      data-testid={`sync-conflict-${conflict.id}-discarded`}
      title={fullValue(conflict.loser)}
      className="rounded-md border p-2"
    >
      <p className="text-xs font-medium text-muted-foreground">Discarded</p>
      {isTombstone ? (
        <p className="mt-1 text-xs font-medium text-muted-foreground">
          {editLabel}
          {editFieldCount === null
            ? ""
            : ` · ${editFieldCount} ${editFieldCount === 1 ? "field" : "fields"}`}
        </p>
      ) : null}
      <ConflictValue value={conflict.loser} />
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {deviceLabel(conflict.loserDeviceName, conflict.loserDeviceId, deviceId)} ·{" "}
        {formatSyncWall(conflict.loserWall)}
      </p>
    </div>
  );
}

export function ConflictGroupView({
  group,
  deviceId,
  busy,
  idPrefix,
  onResolve,
  onLater,
}: {
  group: ConflictGroup;
  deviceId: string | null;
  busy: boolean;
  idPrefix: string;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onLater: (id: number) => void;
}) {
  return (
    <div data-testid={`sync-conflict-group-${group.key}`}>
      <h4 className="text-sm font-medium">{group.title}</h4>
      {group.author ? <p className="text-xs text-muted-foreground">{group.author}</p> : null}
      <ul className="mt-2 flex flex-col gap-2">
        {group.rows.map((conflict) => (
          <ConflictRow
            key={conflict.id}
            conflict={conflict}
            deviceId={deviceId}
            busy={busy}
            idPrefix={idPrefix}
            onResolve={onResolve}
            onLater={onLater}
          />
        ))}
      </ul>
    </div>
  );
}
