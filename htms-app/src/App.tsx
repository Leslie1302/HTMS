import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import WaybillEntry from './pages/WaybillEntry';
import Invoices from './pages/Invoices';
import Admin from './pages/Admin';
import { Crest } from './components/Crest';

function Nav() {
  const { profile, signOut } = useAuth();
  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded text-sm font-medium ${isActive ? 'bg-ministry text-white' : 'text-white/70 hover:bg-gray-800'}`;
  return (
    <header className="bg-gray-900 text-white shadow">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center gap-2">
        <div className="flex items-center gap-3 mr-6">
          <Crest size={40} />
          <div className="leading-tight">
            <div className="font-bold tracking-wide">HTMS</div>
            <div className="text-[11px] text-white/80">Ministry of Energy and Green Transition</div>
          </div>
        </div>
        <NavLink to="/" className={link} end>
          Dashboard
        </NavLink>
        <NavLink to="/waybills" className={link}>
          Waybills
        </NavLink>
        {profile?.role !== 'transporter' && (
          <NavLink to="/invoices" className={link}>
            Invoices and Letters
          </NavLink>
        )}
        {profile?.role === 'admin' && (
          <NavLink to="/admin" className={link}>
            Admin
          </NavLink>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="opacity-90 capitalize">{profile?.role}</span>
          <button onClick={() => signOut()} className="underline">
            Sign out
          </button>
        </div>
      </div>
      {/* Ghana flag accent strip */}
      <div className="flex h-1">
        <div className="flex-1 bg-red-600" />
        <div className="flex-1 bg-yellow-400" />
        <div className="flex-1 bg-green-700" />
      </div>
    </header>
  );
}

export default function App() {
  const { session, loading } = useAuth();
  if (loading) return <div className="p-8 text-gray-500">Loading…</div>;
  if (!session) return <Login />;
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="max-w-7xl w-full mx-auto px-4 py-6 flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/waybills" element={<WaybillEntry />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <footer className="border-t bg-white text-center text-xs text-gray-500 py-3">
        Haulage Transaction Management System · Ministry of Energy and Green Transition · Republic of Ghana
      </footer>
    </div>
  );
}
