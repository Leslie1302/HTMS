import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import WaybillEntry from './pages/WaybillEntry';
import Invoices from './pages/Invoices';
import InvoiceStatus from './pages/InvoiceStatus';
import Admin from './pages/Admin';
import Calculator from './pages/Calculator';
import { Crest } from './components/Crest';
import { NotificationsButton } from './components/NotificationsButton';

function Nav() {
  const { profile, signOut } = useAuth();
  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded text-sm font-medium transition-colors ${isActive ? 'bg-ministry text-white' : 'text-white/70 hover:bg-white/10'}`;
  return (
    <header className="bg-[#141b2b] text-white">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-2">
        <div className="flex items-center gap-2 mr-4">
          <Crest size={36} />
          <div className="leading-tight">
            <div className="font-semibold tracking-wide text-sm">HTMS</div>
            <div className="text-[10px] text-white/60">Ministry of Energy and Green Transition</div>
          </div>
        </div>
        <NavLink to="/" className={link} end>
          <span className="material-symbols-outlined text-base mr-1 align-text-bottom">dashboard</span>
          Dashboard
        </NavLink>
        <NavLink to="/waybills" className={link}>
          <span className="material-symbols-outlined text-base mr-1 align-text-bottom">note_add</span>
          Payment Request Form
        </NavLink>
        <NavLink to="/calculator" className={link}>
          <span className="material-symbols-outlined text-base mr-1 align-text-bottom">calculate</span>
          Trip Calculator
        </NavLink>
        {profile?.role !== 'transporter' && (
          <NavLink to="/invoices" className={link}>
            <span className="material-symbols-outlined text-base mr-1 align-text-bottom">receipt_long</span>
            Payment Requests Status
          </NavLink>
        )}
        {profile?.role === 'transporter' && (
          <NavLink to="/invoice-status" className={link}>
            <span className="material-symbols-outlined text-base mr-1 align-text-bottom">track_changes</span>
            My Status
          </NavLink>
        )}
        {profile?.role === 'admin' && (
          <NavLink to="/admin" className={link}>
            <span className="material-symbols-outlined text-base mr-1 align-text-bottom">admin_panel_settings</span>
            Admin
          </NavLink>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <NotificationsButton />
          <span className="material-symbols-outlined text-base text-white/60">account_circle</span>
          <span className="text-white/80 text-xs capitalize">{profile?.role}</span>
          <button onClick={() => signOut()} className="text-white/60 hover:text-white text-xs underline-offset-2 underline">
            Sign out
          </button>
        </div>
      </div>
      <div className="flex h-[3px]">
        <div className="flex-1 bg-ghana-red" />
        <div className="flex-1 bg-ghana-gold" />
        <div className="flex-1 bg-ghana-green" />
      </div>
    </header>
  );
}

export default function App() {
  const { session, loading } = useAuth();
  if (loading) return <div className="p-8 text-gray-500">Loading…</div>;
  if (!session) return <Login />;
  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <Nav />
      <main className="max-w-7xl w-full mx-auto px-4 py-5 flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/waybills" element={<WaybillEntry />} />
          <Route path="/calculator" element={<Calculator />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoice-status" element={<InvoiceStatus />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <footer className="border-t border-outline-variant bg-white text-center text-xs text-on-surface-variant py-3">
        Haulage Transaction Management System · Ministry of Energy and Green Transition · Republic of Ghana
      </footer>
    </div>
  );
}
