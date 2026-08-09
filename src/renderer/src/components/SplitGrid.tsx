import { useState } from "react";
import { useLayoutStore } from "../store/layout";
import { useAccountsStore } from "../store/accounts";
import { useUiStore } from "../store/ui";
import ChatPane from "./ChatPane";
import { useT } from "../i18n";
import { Pane } from "../types";

export default function SplitGrid(): React.JSX.Element | null {
  const t = useT();
  const tabs = useLayoutStore((s) => s.tabs);
  const activeTabId = useLayoutStore((s) => s.activeTabId);
  const tab = tabs.find((x) => x.id === activeTabId) ?? tabs[0];

  if (!tab) {
    return (
      <div className="split-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="empty-tab">
          <button
            className="primary"
            onClick={() => useLayoutStore.getState().addTab()}
          >
            {t("tab.new")}
          </button>
        </div>
      </div>
    );
  }

  const n = tab.panes.length;
  const columns =
    tab.columns > 0 ? tab.columns : n <= 1 ? 1 : n <= 3 ? n : n === 4 ? 2 : 3;

  return (
    <>
      {/* one strip, above the chats and inside the split view, so a detached window has it too */}
      {n > 1 && (
        <div className="split-bar">
          <label className="split-bar-label" htmlFor="split-columns">
            {t("pane.columns")}
          </label>
          <select
            id="split-columns"
            value={tab.columns}
            onChange={(e) =>
              useLayoutStore
                .getState()
                .setColumns(tab.id, parseInt(e.target.value, 10))
            }
          >
            <option value={0}>{t("pane.auto")}</option>
            {[1, 2, 3, 4].map((c) => (
              <option key={c} value={c}>
                {c} ⬚
              </option>
            ))}
          </select>
        </div>
      )}
      <div
        className="split-grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(columns, 1)}, 1fr)` }}
      >
        {tab.panes.map((pane) => (
          <ChatPane key={pane.id} tabId={tab.id} pane={pane} />
        ))}
        {n === 0 && (
          <div className="empty-tab">
            {/* a fresh tab asks for the channel right away, no extra click — nothing to cancel */}
            <AddPaneForm
              tabId={tab.id}
              onDone={() => undefined}
              cancelable={false}
            />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Adds a pane — or, given `editPane`, points an existing one somewhere else.
 *
 * Switching used to mean closing the pane and opening another, which threw away its position in
 * the grid and its buffer for no reason: the thing being changed is one field. Same form, because
 * it is the same question ("which channel, as whom"), and one form cannot drift from the other.
 */
export function AddPaneForm({
  tabId,
  onDone,
  cancelable = true,
  editPane,
}: {
  tabId: string;
  onDone: () => void;
  cancelable?: boolean;
  editPane?: Pane;
}): React.JSX.Element {
  const t = useT();
  const accounts = useAccountsStore((s) => s.accounts);
  const tabs = useLayoutStore((s) => s.tabs);
  const [channel, setChannel] = useState(editPane?.channel ?? "");
  const [accountId, setAccountId] = useState<string>(
    editPane?.accountId ?? accounts[0]?.id ?? "",
  );

  // suggest channels the user already has in other tabs
  const knownChannels = [
    ...new Set(tabs.flatMap((tab) => tab.panes.map((p) => p.channel))),
  ];

  const submit = (): void => {
    const ch = channel.trim().replace(/^[#@]/, "").toLowerCase();
    if (!ch) return;
    if (editPane) {
      useLayoutStore
        .getState()
        .updatePane(tabId, editPane.id, {
          channel: ch,
          accountId: accountId || null,
        });
    } else {
      useLayoutStore.getState().addPane(tabId, ch, accountId || null);
    }
    onDone();
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div
        className="hint"
        style={{ width: "100%", color: "var(--text-faint)" }}
      >
        {t("pane.addHint")}
      </div>
      <input
        autoFocus
        list="known-channels"
        style={{ minWidth: 130, flex: 1 }}
        placeholder={t("pane.channelPlaceholder")}
        value={channel}
        spellCheck={false}
        onChange={(e) => setChannel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onDone();
        }}
      />
      <datalist id="known-channels">
        {knownChannels.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <select
        value={accountId}
        onChange={(e) => {
          if (e.target.value === "__add__") {
            useUiStore.getState().setAddAccountOpen(true);
            return;
          }
          setAccountId(e.target.value);
        }}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
        <option value="">{t("pane.readOnly")}</option>
        <option value="__add__">+ {t("auth.addAccount")}</option>
      </select>
      <button className="primary" onClick={submit}>
        {t("misc.add")}
      </button>
      {cancelable && (
        <button className="ghost" title={t("oe.cancel")} onClick={onDone}>
          ✕
        </button>
      )}
    </div>
  );
}
