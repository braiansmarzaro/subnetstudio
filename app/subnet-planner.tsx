"use client";

import { ArrowDown, CornerDownRight, Download, LoaderCircle, Network, RotateCcw, Split, Undo2 } from "lucide-react";
import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

type Subnet = { cidr: string; network: number; prefix: number };
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

function SubnetNode({ subnet, splitIds, collapsingIds, onToggle }: {
  subnet: Subnet;
  splitIds: Set<string>;
  collapsingIds: Set<string>;
  onToggle: (subnet: Subnet) => void;
}) {
  const isSplit = splitIds.has(subnet.cidr);
  const isCollapsing = collapsingIds.has(subnet.cidr);
  const canSplit = subnet.prefix < 32;
  const lastAddress = subnet.network + 2 ** (32 - subnet.prefix) - 1;

  return (
    <div className="tree-branch">
      <button
        className={`subnet-node ${isSplit ? "subnet-node--parent" : ""}`}
        data-subnet-id={subnet.cidr}
        type="button"
        onClick={() => canSplit && onToggle(subnet)}
        disabled={!canSplit || isCollapsing}
        aria-label={canSplit ? `${isSplit ? "Unsplit" : "Split"} ${subnet.cidr}` : `${subnet.cidr} network`}
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

      {isSplit && (
        <div className={`children-wrap ${isCollapsing ? "children-wrap--collapsing" : ""}`}>
          <div className="tree-stem" aria-hidden="true" />
          <div className="tree-children">
            {childSubnets(subnet).map((child) => (
              <SubnetNode key={child.cidr} subnet={child} splitIds={splitIds} collapsingIds={collapsingIds} onToggle={onToggle} />
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
  const [splitOrder, setSplitOrder] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [collapsingIds, setCollapsingIds] = useState<Set<string>>(new Set());
  const collapseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const layoutAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const previousNodePositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const treeCanvasRef = useRef<HTMLDivElement>(null);
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
    setSplitOrder([]);
    setError("");
  }

  function resetTree() {
    clearPendingCollapses();
    setRoot(null);
    setSplitOrder([]);
    setError("");
    setExportError("");
  }

  function toggleSubnet(subnet: Subnet) {
    if (!splitIds.has(subnet.cidr)) {
      captureNodePositions();
      setSplitOrder((current) => [...current, subnet.cidr]);
      return;
    }

    setCollapsingIds((current) => new Set(current).add(subnet.cidr));
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 380;
    const timer = setTimeout(() => {
      captureNodePositions();
      setSplitOrder((current) => current.filter((cidr) => !isWithinSubnet(cidr, subnet)));
      setCollapsingIds((current) => {
        const next = new Set(current);
        next.delete(subnet.cidr);
        return next;
      });
      collapseTimersRef.current.delete(subnet.cidr);
    }, duration);
    collapseTimersRef.current.set(subnet.cidr, timer);
  }

  function undoLastSplit() {
    captureNodePositions();
    setSplitOrder((current) => current.slice(0, -1));
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
            <button className="export-button" type="button" onClick={exportTree} disabled={!root || isExporting || collapsingIds.size > 0}>
              {isExporting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
              {isExporting ? "Exporting" : "Export PNG"}
            </button>
            <button className="icon-button" type="button" onClick={undoLastSplit} disabled={!splitOrder.length || collapsingIds.size > 0} title="Undo last split" aria-label="Undo last split">
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
            <SubnetNode subnet={root} splitIds={splitIds} collapsingIds={collapsingIds} onToggle={toggleSubnet} />
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
    </main>
  );
}
