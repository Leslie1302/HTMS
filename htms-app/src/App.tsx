import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import WaybillEntry from './pages/WaybillEntry';
import Invoices from './pages/Invoices';
import Admin from './pages/Admin';

function Nav() {
  const { profile, signOut } = useAuth();
  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded text-sm font-medium ${isActive ? 'bg-ministry-dark text-white' : 'text-white/80 hover:bg-ministry-dark'}`;
  return (
    <header className="bg-ministry text-white">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-2">
        <span className="font-bold mr-4">HTMS</span>
        <NavLink to="/" className={link} end>
          Dashboard
        </NavLink>
        <NavLink to="/waybills" className={link}>
          Waybills
        </NavLink>
        {profile?.role !== 'transporter' && (
          <NavLink to="/invoices" className={link}>
            Invoices
          </NavLink>
        )}
        {profile?.role === 'admin' && (
          <NavLink to="/admin" className={link}>
            Admin
          </NavLink>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="opacity-90">{profile?.role}</span>
          <button onClick={() => signOut()} className="underline">
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const { session, loading } = useAuth();
  if (loading) return <div className="p-8 text-gray-500">Loading…</div>;
  if (!session) return <Login />;
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/waybills" element={<WaybillEntry />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
