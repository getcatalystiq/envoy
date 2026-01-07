import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Callback } from './pages/Callback';
import { Dashboard } from './pages/Dashboard';
import { Campaigns } from './pages/Campaigns';
import { Targets } from './pages/Targets';
import { Content } from './pages/Content';
import { Analytics } from './pages/Analytics';
import { Setup } from './pages/Setup';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/callback" element={<Callback />} />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />

      <Route
        path="/campaigns"
        element={
          <ProtectedRoute>
            <Campaigns />
          </ProtectedRoute>
        }
      />

      <Route
        path="/targets"
        element={
          <ProtectedRoute>
            <Targets />
          </ProtectedRoute>
        }
      />

      <Route
        path="/content"
        element={
          <ProtectedRoute>
            <Content />
          </ProtectedRoute>
        }
      />

      <Route
        path="/analytics"
        element={
          <ProtectedRoute>
            <Analytics />
          </ProtectedRoute>
        }
      />

      <Route
        path="/setup"
        element={
          <ProtectedRoute>
            <Setup />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
