"use client";

import { ArrowDown, Check, CornerDownRight, Download, FileDown, FileUp, Heart, LoaderCircle, Network, Pencil, RotateCcw, Split, Undo2, X } from "lucide-react";
import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

type Subnet = { cidr: string; network: number; prefix: number };
type SplitState = { order: string[]; undoStack: string[][] };
type PlannerDocument = {
  format: "subnet-studio";
  version: 1;
  root: string;
  splits: string[];
  names: Record<string, string>;
};
const INITIAL_CIDR = "10.0.0.0/16";

function numberToIp(value: number) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function parseCidr(value: string): Subnet | null {
  const match = value.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/);
  if (!match) return null;

  const octets = match[1].split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return null;

  const prefix = Number(match[2]);
  const address = octets.reduce((total, octet) => total * 256 + octet, 0);
  const size = 2 ** (32 - prefix);
  const network = Math.floor(address / size) * size;
  return { cidr: `${numberToIp(network)}/${prefix}`, network, prefix };
}

function childSubnets(subnet: Subnet): [Subnet, Subnet] {
  const prefix = subnet.prefix + 1;
  const size = 2 ** (32 - prefix);
  return [subnet.network, subnet.network + size].map((network) => ({
    cidr: `${numberToIp(network)}/${prefix}`,
    network,
    prefix,
  })) as [Subnet, Subnet];
}

function formatAddresses(prefix: number) {
  return new Intl.NumberFormat("en-US").format(2 ** (32 - prefix));
}

function isWithinSubnet(cidr: string, parent: Subnet) {
  const candidate = parseCidr(cidr);
  const parentSize = 2 ** (32 - parent.prefix);
  return candidate !== null
    && candidate.prefix >= parent.prefix
    && candidate.network >= parent.network
    && candidate.network < parent.network + parentSize;
}

function parsePlannerDocument(value: unknown): { root: Subnet; splits: string[]; names: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The JSON must contain a Subnet Studio document.");

  const document = value as Partial<PlannerDocument>;
  if (document.format !== "subnet-studio" || document.version !== 1) throw new Error("This JSON format or version is not supported.");
  if (typeof document.root !== "string") throw new Error("The root network is missing.");

  const root = parseCidr(document.root);
  if (!root || root.cidr !== document.root) throw new Error("The root network must be a canonical IPv4 CIDR.");
  if (!Array.isArray(document.splits) || document.splits.length > 2048) throw new Error("The split history is invalid or too large.");

  const available = new Set([root.cidr]);
  const splits: string[] = [];
  for (const cidr of document.splits) {
    const subnet = typeof cidr === "string" ? parseCidr(cidr) : null;
    if (!subnet || subnet.cidr !== cidr || subnet.prefix === 32 || !available.has(cidr)) {
      throw new Error(`The split history is invalid at ${String(cidr)}.`);
    }
    available.delete(cidr);
    childSubnets(subnet).forEach((child) => available.add(child.cidr));
    splits.push(cidr);
  }

  if (!document.names || typeof document.names !== "object" || Array.isArray(document.names)) throw new Error("The block names are invalid.");
  const nameEntries = Object.entries(document.names);
  if (nameEntries.length > 4096) throw new Error("The document contains too many block names.");

  const names: Record<string, string> = {};
  for (const [cidr, value] of nameEntries) {
    const subnet = parseCidr(cidr);
    if (!subnet || subnet.cidr !== cidr || !isWithinSubnet(cidr, root) || typeof value !== "string" || !value.trim() || value.trim().length > 32) {
      throw new Error(`The block name for ${cidr} is invalid.`);
    }
    names[cidr] = value.trim();
  }

  return { root, splits, names };
}

function SubnetNode({ subnet, name, nameByCidr, splitIds, collapsingIds, isTreeBusy, onRename, onToggle }: {
  subnet: Subnet;
  name: string;
  nameByCidr: Record<string, string>;
  splitIds: Set<string>;
  collapsingIds: Set<string>;
  isTreeBusy: boolean;
  onRename: (cidr: string, name: string) => void;
  onToggle: (subnet: Subnet) => void;
}) {
  const isSplit = splitIds.has(subnet.cidr);
  const isCollapsing = collapsingIds.has(subnet.cidr);
  const canSplit = subnet.prefix < 32;
  const lastAddress = subnet.network + 2 ** (32 - subnet.prefix) - 1;
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(name);

  function beginRename() {
    setNameInput(name);
    setIsRenaming(true);
  }

  function saveName() {
    onRename(subnet.cidr, nameInput.trim());
    setIsRenaming(false);
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setNameInput(name);
      setIsRenaming(false);
    }
  }

  return (
    <div className="tree-branch">
      <div className={`subnet-node ${isSplit ? "subnet-node--parent" : ""}`} data-subnet-id={subnet.cidr}>
        {isRenaming ? (
          <form className="node-name-editor" onSubmit={(event) => { event.preventDefault(); saveName(); }} data-export-ignore="true">
            <input
              autoFocus
              aria-label={`Name for ${subnet.cidr}`}
              maxLength={32}
              onChange={(event) => setNameInput(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleNameKeyDown}
              placeholder="Block name"
              value={nameInput}
            />
            <button type="submit" title="Save name" aria-label={`Save name for ${subnet.cidr}`}><Check size={14} aria-hidden="true" /></button>
            <button type="button" onClick={() => { setNameInput(name); setIsRenaming(false); }} title="Cancel rename" aria-label="Cancel rename"><X size={14} aria-hidden="true" /></button>
          </form>
        ) : (
          <button className={`node-name-button ${name ? "node-name-button--named" : ""}`} type="button" onClick={beginRename} title={name ? "Rename block" : "Name block"} aria-label={`${name ? "Rename" : "Name"} ${subnet.cidr}`}>
            <span>{name || "Name block"}</span><Pencil size={12} aria-hidden="true" />
          </button>
        )}
        <button
          className="node-split-button"
          type="button"
          onClick={() => canSplit && onToggle(subnet)}
          disabled={!canSplit || isTreeBusy}
          aria-label={canSplit ? `${isSplit ? "Unsplit" : "Split"} ${name || subnet.cidr}` : `${name || subnet.cidr} network`}
        >
          <span className="node-heading">
            <span className="node-prefix">/{subnet.prefix}</span>
            <span className="node-address">{numberToIp(subnet.network)}</span>
          </span>
          <span className="node-range">
            {numberToIp(subnet.network)} <ArrowDown size={12} aria-hidden="true" /> {numberToIp(lastAddress)}
          </span>
          <span className="node-footer">
            <span>{formatAddresses(subnet.prefix)} addresses</span>
            {canSplit && !isSplit && <span className="split-hint"><Split size={13} aria-hidden="true" /> Split</span>}
            {isSplit && <span className="unsplit-hint"><RotateCcw size={13} aria-hidden="true" /> Unsplit</span>}
            {!canSplit && <span className="host-label">Single host</span>}
          </span>
        </button>
      </div>

      {isSplit && (
        <div className={`children-wrap ${isCollapsing ? "children-wrap--collapsing" : ""}`}>
          <div className="tree-stem" aria-hidden="true" />
          <div className="tree-children">
            {childSubnets(subnet).map((child) => (
              <SubnetNode key={child.cidr} subnet={child} name={nameByCidr[child.cidr] ?? ""} nameByCidr={nameByCidr} splitIds={splitIds} collapsingIds={collapsingIds} isTreeBusy={isTreeBusy} onRename={onRename} onToggle={onToggle} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SubnetPlanner() {
  const [cidrInput, setCidrInput] = useState(INITIAL_CIDR);
  const [root, setRoot] = useState<Subnet | null>(null);
  const [splitState, setSplitState] = useState<SplitState>({ order: [], undoStack: [] });
  const [nameByCidr, setNameByCidr] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [collapsingIds, setCollapsingIds] = useState<Set<string>>(new Set());
  const collapseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const layoutAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const previousNodePositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const treeCanvasRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const splitOrder = splitState.order;
  const splitIds = new Set(splitOrder);
  const nodeCount = 1 + splitOrder.length * 2;
  const leafCount = 1 + splitOrder.length;

  useEffect(() => {
    const collapseTimers = collapseTimersRef.current;
    const layoutAnimations = layoutAnimationsRef.current;
    return () => {
      collapseTimers.forEach(clearTimeout);
      layoutAnimations.forEach((animation) => animation.cancel());
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = treeCanvasRef.current;
    const previousPositions = previousNodePositionsRef.current;
    if (!canvas || previousPositions.size === 0) return;

    layoutAnimationsRef.current.forEach((animation) => animation.cancel());
    layoutAnimationsRef.current.clear();

    const nodes = Array.from(canvas.querySelectorAll<HTMLElement>("[data-subnet-id]"));
    const currentPositions = new Map(nodes.map((node) => [node.dataset.subnetId!, node.getBoundingClientRect()]));
    const offsets = new Map<string, { x: number; y: number }>();

    nodes.forEach((node) => {
      const id = node.dataset.subnetId!;
      const previous = previousPositions.get(id);
      const current = currentPositions.get(id)!;
      if (previous) offsets.set(id, { x: previous.left - current.left, y: previous.top - current.top });
    });

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      nodes.forEach((node) => {
        const id = node.dataset.subnetId!;
        const offset = offsets.get(id);
        const branch = node.closest<HTMLElement>(".tree-branch");
        if (!offset || !branch) return;

        const parentBranch = branch.parentElement?.closest<HTMLElement>(".tree-branch");
        const parentId = parentBranch?.querySelector<HTMLElement>(":scope > [data-subnet-id]")?.dataset.subnetId;
        const parentOffset = parentId ? offsets.get(parentId) : undefined;
        const x = offset.x - (parentOffset?.x ?? 0);
        const y = offset.y - (parentOffset?.y ?? 0);
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;

        const animation = branch.animate(
          [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
          { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
        layoutAnimationsRef.current.set(id, animation);
        const clearAnimation = () => {
          if (layoutAnimationsRef.current.get(id) === animation) layoutAnimationsRef.current.delete(id);
        };
        animation.onfinish = clearAnimation;
        animation.oncancel = clearAnimation;
      });
    }

    previousPositions.clear();
  }, [root, splitOrder]);

  function captureNodePositions() {
    const nodes = treeCanvasRef.current?.querySelectorAll<HTMLElement>("[data-subnet-id]") ?? [];
    previousNodePositionsRef.current = new Map(
      Array.from(nodes, (node) => [node.dataset.subnetId!, node.getBoundingClientRect()]),
    );
  }

  function clearPendingCollapses() {
    collapseTimersRef.current.forEach(clearTimeout);
    collapseTimersRef.current.clear();
    setCollapsingIds(new Set());
  }

  function createNetwork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const subnet = parseCidr(cidrInput);
    if (!subnet) {
      setError("Enter a valid IPv4 CIDR, such as 10.0.0.0/16.");
      return;
    }
    clearPendingCollapses();
    setRoot(subnet);
    setCidrInput(subnet.cidr);
    setSplitState({ order: [], undoStack: [] });
    setNameByCidr({});
    setError("");
  }

  function resetTree() {
    clearPendingCollapses();
    setRoot(null);
    setSplitState({ order: [], undoStack: [] });
    setNameByCidr({});
    setError("");
    setExportError("");
  }

  function toggleSubnet(subnet: Subnet) {
    if (!splitIds.has(subnet.cidr)) {
      captureNodePositions();
      setSplitState((current) => ({
        order: [...current.order, subnet.cidr],
        undoStack: [...current.undoStack, current.order],
      }));
      return;
    }

    setCollapsingIds((current) => new Set(current).add(subnet.cidr));
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 380;
    const timer = setTimeout(() => {
      captureNodePositions();
      setSplitState((current) => ({
        order: current.order.filter((cidr) => !isWithinSubnet(cidr, subnet)),
        undoStack: [...current.undoStack, current.order],
      }));
      setCollapsingIds((current) => {
        const next = new Set(current);
        next.delete(subnet.cidr);
        return next;
      });
      collapseTimersRef.current.delete(subnet.cidr);
    }, duration);
    collapseTimersRef.current.set(subnet.cidr, timer);
  }

  function undoLastAction() {
    captureNodePositions();
    setSplitState((current) => ({
      order: current.undoStack.at(-1) ?? current.order,
      undoStack: current.undoStack.slice(0, -1),
    }));
  }

  function renameSubnet(cidr: string, name: string) {
    setNameByCidr((current) => {
      const next = { ...current };
      if (name) next[cidr] = name;
      else delete next[cidr];
      return next;
    });
  }

  function exportJson() {
    if (!root) return;

    const document: PlannerDocument = {
      format: "subnet-studio",
      version: 1,
      root: root.cidr,
      splits: splitOrder,
      names: nameByCidr,
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: "application/json" }));
    const link = window.document.createElement("a");
    link.download = `subnet-tree-${root.cidr.replace("/", "-")}.json`;
    link.href = url;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setExportError("");
  }

  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const document = parsePlannerDocument(JSON.parse(await file.text()));
      clearPendingCollapses();
      setRoot(document.root);
      setCidrInput(document.root.cidr);
      setSplitState({
        order: document.splits,
        undoStack: document.splits.map((_, index) => document.splits.slice(0, index)),
      });
      setNameByCidr(document.names);
      setError("");
      setExportError("");
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The JSON file could not be imported.");
    }
  }

  async function exportTree() {
    if (!root || !treeCanvasRef.current) return;

    setIsExporting(true);
    setExportError("");

    try {
      const { toPng } = await import("html-to-image");
      const canvas = treeCanvasRef.current;
      const dataUrl = await toPng(canvas, {
        backgroundColor: "#fcfcfb",
        cacheBust: true,
        filter: (node) => !(node instanceof HTMLElement && node.dataset.exportIgnore === "true"),
        pixelRatio: 2,
        width: canvas.scrollWidth,
        height: canvas.scrollHeight,
        style: {
          height: `${canvas.scrollHeight}px`,
          overflow: "visible",
          width: `${canvas.scrollWidth}px`,
        },
      });
      const link = document.createElement("a");
      link.download = `subnet-tree-${root.cidr.replace("/", "-")}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setExportError("The image could not be exported. Please try again.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Subnet Studio home">
          <span className="brand-mark"><Network size={20} aria-hidden="true" /></span>
          <span>Subnet Studio</span>
        </a>
        <span className="header-status"><span aria-hidden="true" /> IPv4 workspace</span>
      </header>

      <section className="intro" id="top">
        <div>
          <p className="eyebrow"><CornerDownRight size={14} aria-hidden="true" /> Address planning</p>
          <h1>Shape your network,<br />one split at a time.</h1>
        </div>
        <p className="intro-copy">Start with an IPv4 CIDR block. Select any leaf to divide it into two equal subnets and build a clear allocation tree.</p>
      </section>

      <section className="workspace" aria-label="Subnet planning workspace">
        <form className="network-form" onSubmit={createNetwork} noValidate>
          <label htmlFor="cidr">Starting network</label>
          <div className="input-row">
            <div className={`input-wrap ${error ? "input-wrap--error" : ""}`}>
              <span className="input-icon" aria-hidden="true">IP</span>
              <input
                id="cidr"
                name="cidr"
                value={cidrInput}
                onChange={(event) => { setCidrInput(event.target.value); setError(""); }}
                placeholder={INITIAL_CIDR}
                aria-describedby={error ? "cidr-error" : "cidr-help"}
                aria-invalid={Boolean(error)}
                spellCheck="false"
              />
            </div>
            <button className="primary-button" type="submit">
              <Network size={17} aria-hidden="true" /> {root ? "Start new tree" : "Create network"}
            </button>
          </div>
          <p className={error ? "field-error" : "field-help"} id={error ? "cidr-error" : "cidr-help"} role={error ? "alert" : undefined}>
            {error || "IPv4 address with prefix length (0–32)"}
          </p>
        </form>

        <div className="workspace-bar">
          <div className="workspace-title">
            <span className="workspace-icon"><Split size={18} aria-hidden="true" /></span>
            <div>
              <h2>Subnet tree</h2>
              <p>{root ? `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} · ${leafCount} leaf ${leafCount === 1 ? "network" : "networks"}` : "Ready for a starting network"}</p>
            </div>
          </div>
          <div className="tree-actions">
            <input ref={importInputRef} type="file" accept="application/json,.json" onChange={importJson} hidden />
            <button className="icon-button" type="button" onClick={() => importInputRef.current?.click()} title="Import JSON" aria-label="Import JSON">
              <FileUp size={17} aria-hidden="true" />
            </button>
            <button className="icon-button" type="button" onClick={exportJson} disabled={!root || collapsingIds.size > 0} title="Export JSON" aria-label="Export JSON">
              <FileDown size={17} aria-hidden="true" />
            </button>
            <button className="export-button" type="button" onClick={exportTree} disabled={!root || isExporting || collapsingIds.size > 0}>
              {isExporting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
              {isExporting ? "Exporting" : "Export PNG"}
            </button>
            <button className="icon-button" type="button" onClick={undoLastAction} disabled={!splitState.undoStack.length || collapsingIds.size > 0} title="Undo last action" aria-label="Undo last action">
              <Undo2 size={17} aria-hidden="true" />
            </button>
            <button className="icon-button" type="button" onClick={resetTree} disabled={!root} title="Reset workspace" aria-label="Reset workspace">
              <RotateCcw size={17} aria-hidden="true" />
            </button>
          </div>
        </div>

        {exportError && <p className="export-error" role="alert">{exportError}</p>}

        <div ref={treeCanvasRef} className={`tree-canvas ${root ? "tree-canvas--active" : ""}`}>
          {root && <p className="export-title">Subnet Studio · {root.cidr}</p>}
          {root ? (
            <SubnetNode subnet={root} name={nameByCidr[root.cidr] ?? ""} nameByCidr={nameByCidr} splitIds={splitIds} collapsingIds={collapsingIds} isTreeBusy={collapsingIds.size > 0} onRename={renameSubnet} onToggle={toggleSubnet} />
          ) : (
            <div className="empty-state">
              <span className="empty-graphic" aria-hidden="true"><Network size={32} /></span>
              <h2>Your subnet tree starts here</h2>
              <p>Enter a CIDR block above to create the first node.</p>
            </div>
          )}
        </div>

        <footer className="legend">
          <span><i className="legend-dot legend-dot--leaf" /> Available to split</span>
          <span><i className="legend-dot legend-dot--parent" /> Already divided</span>
          <span className="legend-tip"><Split size={13} aria-hidden="true" /> Select a leaf node to split it</span>
        </footer>
      </section>

      <footer className="site-footer">
        <a
          className="author-link"
          href="https://www.linkedin.com/in/deividsmarzaro/"
          target="_blank"
          rel="noreferrer"
          aria-label="Built with love by Deivid Smarzaro on LinkedIn"
        >
          <span>Built with</span>
          <Heart className="author-heart" size={14} fill="currentColor" aria-hidden="true" />
          <span>by Deivid Smarzaro</span>
          <svg className="linkedin-icon" width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45ZM22.23 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45C23.2 24 24 23.23 24 22.27V1.73C24 .77 23.2 0 22.22 0Z" />
          </svg>
        </a>
      </footer>
    </main>
  );
}
