import { Link } from 'react-router-dom';
import { Crest } from '../components/Crest';
import { STAGE_LABELS, ALL_STAGES } from '../../shared/lifecycle';

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
        <div className="relative max-w-6xl mx-auto px-5 pt-32 pb-24">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-white/80 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-ghana-green" /> Haulage Transport Management System · Ghana
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
