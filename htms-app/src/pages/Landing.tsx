import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Crest } from '../components/Crest';
import { STAGE_LABELS, ALL_STAGES } from '../../shared/lifecycle';

/** Tiny Ghana flag (red/gold/green with black star). */
function GhanaFlag({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 14" className={`w-5 h-[13px] rounded-[2px] shadow-sm ${className}`} aria-label="Ghana">
      <rect width="21" height="14" fill="#006b3f" />
      <rect width="21" height="9.33" fill="#fcd116" />
      <rect width="21" height="4.66" fill="#ce1126" />
      <path d="M10.5 5.1l.77 2.36h2.48l-2.0 1.46.76 2.36-2.0-1.46-2.0 1.46.76-2.36-2.0-1.46h2.48z" fill="#000" />
    </svg>
  );
}

/**
 * Hero map: a truck driving pin-to-pin across a real Ghana silhouette (JS rAF).
 * All geometry lives in one SVG (viewBox 0..70 × 0..100), derived from
 * lon/lat so the country shape, cities and truck share one coordinate space.
 */
const GHANA_PATH =
  'M8,2.6 L35.5,2.6 L37,4.2 L48.8,1.1 L51.9,2.6 L57.4,1.9 L56.7,13.5 L59.8,26 L55.9,36.9 ' +
  'L59.8,46.2 L65.3,58.6 L60.6,68 L66.9,78.8 L69.8,78.8 L66.9,81.9 L54.3,83.8 L48,87.4 ' +
  'L35.2,94.4 L22.9,97.5 L18.2,99.8 L8,96.7 L4.9,85.1 L5.6,71.1 L0.9,57.1 L6.4,41.5 ' +
  'L8,26 L7.2,12 Z';
const CITIES = [
  { x: 51.4, y: 85.5, name: 'Tema', anchor: 'start' },
  { x: 25.7, y: 69.7, name: 'Kumasi', anchor: 'end' },
  { x: 38.0, y: 27.5, name: 'Tamale', anchor: 'end' },
  { x: 51.5, y: 26.9, name: 'Yendi', anchor: 'start' },
  { x: 52.1, y: 35.9, name: 'Bimbilla', anchor: 'start' },
];
function RouteMap() {
  const truck = useRef<SVGGElement>(null);

  useEffect(() => {
    let seg = 0;
    let start = performance.now();
    let paused = false;
    let pauseUntil = 0;
    let raf = 0;
    const SEG_MS = 1900;
    const PAUSE_MS = 700;

    const tick = (now: number) => {
      const a = CITIES[seg];
      const b = CITIES[(seg + 1) % CITIES.length];
      let t = (now - start) / SEG_MS;
      if (t >= 1) {
        t = 1;
        if (!paused) { paused = true; pauseUntil = now + PAUSE_MS; }
        if (now >= pauseUntil) { seg = (seg + 1) % CITIES.length; start = now; paused = false; }
      }
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const dir = b.x - a.x >= 0 ? 1 : -1;
      truck.current?.setAttribute('transform', `translate(${x} ${y}) scale(${dir} 1)`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const routePoints = [...CITIES, CITIES[0]].map((c) => `${c.x},${c.y}`).join(' ');

  return (
    <div className="relative w-full aspect-[4/3] rounded-2xl bg-[#0f1523] border border-white/10 overflow-hidden shadow-2xl">
      <svg viewBox="-7 -6 84 112" className="absolute inset-0 w-full h-full">
        {/* Ghana silhouette */}
        <path d={GHANA_PATH} fill="#16273f" stroke="#2e7d32" strokeWidth="0.6" strokeLinejoin="round" />
        {/* route */}
        <polyline points={routePoints} fill="none" stroke="#8cc98f" strokeWidth="0.7" strokeDasharray="2 2" className="route-dash" />
        {/* pins + labels */}
        {CITIES.map((c) => (
          <g key={c.name}>
            <circle cx={c.x} cy={c.y} r="1.9" fill="#fcd116" opacity="0.25" />
            <circle cx={c.x} cy={c.y} r="1.1" fill="#fcd116" stroke="#0f1523" strokeWidth="0.3" />
            <text x={c.anchor === 'end' ? c.x - 2.4 : c.x + 2.4} y={c.y + 0.9} textAnchor={c.anchor as 'start' | 'end'} fontSize="3" fill="#e6ecf5" fontWeight="600">{c.name}</text>
          </g>
        ))}
        {/* truck */}
        <g ref={truck} transform="translate(51.4 85.5)">
          <circle r="3.4" fill="#2e7d32" />
          <rect x="-2.3" y="-1.4" width="2.7" height="2.2" rx="0.3" fill="#fff" />
          <path d="M0.4 -0.6 L1.7 -0.6 L2.3 0.2 L2.3 0.8 L0.4 0.8 Z" fill="#fff" />
          <circle cx="-1.3" cy="1.1" r="0.6" fill="#0f1523" />
          <circle cx="1.2" cy="1.1" r="0.6" fill="#0f1523" />
        </g>
      </svg>
      <div className="absolute bottom-3 left-4 text-[11px] text-white/50 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-ghana-green animate-pulse" /> Live haulage across Ghana
      </div>
      <style>{`.route-dash{animation:htms-dash 1.4s linear infinite}@keyframes htms-dash{to{stroke-dashoffset:-8}}`}</style>
    </div>
  );
}

const FEATURES: { icon: string; title: string; body: string }[] = [
  { icon: 'note_add', title: 'Waybill capture', body: 'Log every trip — origin, destination, poles, trailer, trips — in seconds. No more shoeboxes of paper waybills.' },
  { icon: 'calculate', title: 'Automatic FIDIC costing', body: 'Haulage cost is computed from surveyed chart distances and fuel-indexed FIDIC escalation. No spreadsheets, no disputes.' },
  { icon: 'description', title: 'One-click documents', body: 'Generate the invoice, payment-request letter, PD memo and signatory sheet as clean PDFs — built from the data you already entered.' },
  { icon: 'account_tree', title: '11-step approval pipeline', body: 'Every payment request moves through a forward-only, auditable workflow from generation to paid — nothing skips a stage.' },
  { icon: 'notifications_active', title: 'Instant notifications', body: 'Transporters and the Directorate are alerted the moment an invoice advances, so nothing sits waiting on a desk.' },
  { icon: 'shield', title: 'Full audit trail', body: 'Every action, by every actor, is logged and searchable — transparency oversight for Ministry logistics, end to end.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-surface text-on-surface">
      {/* ── Top bar ── */}
      <header className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Crest size={34} />
            <div className="leading-tight text-white">
              <div className="font-semibold tracking-wide text-sm">HTMS</div>
              <div className="text-[10px] text-white/60">Ministry of Energy &amp; Green Transition</div>
            </div>
          </div>
          <Link to="/login" className="text-sm font-medium text-white/90 hover:text-white border border-white/25 rounded-lg px-4 py-2 hover:bg-white/10 transition-colors">
            Sign in
          </Link>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-[#141b2b] text-white">
        <div className="absolute inset-0 opacity-[0.15] bg-[radial-gradient(60%_60%_at_70%_10%,#2e7d32_0%,transparent_60%)]" />
        <div className="relative max-w-6xl mx-auto px-5 pt-32 pb-24 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-white/80 mb-6">
              <GhanaFlag /> Haulage Transport Management System · Ghana
            </div>
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight max-w-3xl leading-[1.05]">
              From waybill to cedi,<br />without the paper chase.
            </h1>
            <p className="mt-6 text-lg text-white/70 max-w-2xl">
              HTMS turns stacks of haulage waybills into fuel-indexed invoices, approval-ready documents and a fully audited
              payment pipeline — for the Ministry of Energy&apos;s electrical-materials transport.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link to="/login" className="inline-flex items-center gap-2 bg-[#2e7d32] hover:opacity-90 text-white font-semibold rounded-lg px-6 py-3.5 text-sm transition-opacity">
                <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>login</span>
                Get started
              </Link>
              <a href="#how" className="inline-flex items-center gap-2 text-white/80 hover:text-white font-medium rounded-lg px-5 py-3.5 text-sm border border-white/20 hover:bg-white/5 transition-colors">
                See how it works
              </a>
            </div>
            <div className="mt-12 flex flex-wrap gap-x-10 gap-y-4 text-sm">
              {[['11-step', 'audited pipeline'], ['FIDIC-indexed', 'haulage costing'], ['4 documents', 'generated instantly'], ['Every action', 'logged']].map(([a, b]) => (
                <div key={a}>
                  <div className="text-2xl font-bold text-white">{a}</div>
                  <div className="text-white/55">{b}</div>
                </div>
              ))}
            </div>
          </div>
          <RouteMap />
        </div>
        <div className="flex h-1.5">
          <div className="flex-1 bg-ghana-red" />
          <div className="flex-1 bg-ghana-gold" />
          <div className="flex-1 bg-ghana-green" />
        </div>
      </section>

      {/* ── Features ── */}
      <section className="max-w-6xl mx-auto px-5 py-20">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight">Everything a payment request needs — in one place.</h2>
          <p className="mt-3 text-on-surface-variant">Capture the trip once. HTMS handles the maths, the paperwork, the approvals and the trail.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-10">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-white rounded-2xl border border-outline-variant p-6 hover:shadow-sm transition-shadow">
              <div className="w-11 h-11 rounded-xl bg-[#e8f5e9] text-[#0d631b] grid place-items-center mb-4">
                <span className="material-symbols-outlined">{f.icon}</span>
              </div>
              <h3 className="font-semibold text-lg">{f.title}</h3>
              <p className="text-sm text-on-surface-variant mt-2 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pipeline ── */}
      <section id="how" className="bg-[#0f1523] text-white py-20">
        <div className="max-w-6xl mx-auto px-5">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight">One transparent pipeline, eleven accountable steps.</h2>
            <p className="mt-3 text-white/60">Each payment request moves forward only — from the moment it&apos;s generated to the day it&apos;s paid. Every transition is stamped, attributed and notified.</p>
          </div>
          <div className="mt-10 flex flex-wrap gap-2">
            {ALL_STAGES.map((s, i) => (
              <div key={s} className="flex items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-3 py-2">
                <span className="w-6 h-6 rounded-full bg-[#2e7d32] grid place-items-center text-[11px] font-bold">{i + 1}</span>
                <span className="text-sm text-white/85">{STAGE_LABELS[s]}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="max-w-6xl mx-auto px-5 py-20 text-center">
        <Crest size={64} />
        <h2 className="mt-6 text-3xl font-bold tracking-tight">Ready to move payments, not paper?</h2>
        <p className="mt-3 text-on-surface-variant max-w-xl mx-auto">Sign in to the HTMS portal. Access is provisioned by your Ministry administrator.</p>
        <div className="mt-8 flex justify-center gap-3">
          <Link to="/login" className="inline-flex items-center gap-2 bg-[#2e7d32] hover:opacity-90 text-white font-semibold rounded-lg px-6 py-3.5 text-sm">
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>login</span>
            Sign in to HTMS
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant">
        <div className="max-w-6xl mx-auto px-5 py-8 flex flex-col md:flex-row items-center justify-between gap-3 text-sm text-on-surface-variant">
          <div className="flex items-center gap-2">
            <Crest size={24} />
            <span>HTMS · Ministry of Energy &amp; Green Transition, Ghana</span>
          </div>
          <span className="text-outline">Secure Ministry access · Audit-logged</span>
        </div>
      </footer>
    </div>
  );
}
