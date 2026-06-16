import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { IntersectionsPage } from './pages/Intersections';
import { ReportsPage } from './pages/Reports';
import { UsersPage } from './pages/Users';
import { ManualPage } from './pages/Manual';
import { SignalTimingPage } from './pages/SignalTiming';
import { CameraDetailPage } from './pages/CameraDetail';
import { VideosPage } from './pages/Videos';
import { IntersectionDetailPage } from './pages/IntersectionDetail';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<IntersectionsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="manual" element={<ManualPage />} />
            <Route path="intersections/:id" element={<IntersectionDetailPage />} />
            <Route path="timing/:id" element={<SignalTimingPage />} />
            <Route path="cameras/:id" element={<CameraDetailPage />} />
            <Route path="videos"     element={<VideosPage />} />
            <Route path="videos/:id" element={<VideosPage />} />

            {/* Legacy routes — keep working but redirect to home */}
            <Route path="intersections"   element={<Navigate to="/" replace />} />
            <Route path="cameras"         element={<Navigate to="/" replace />} />
            <Route path="recommendations" element={<Navigate to="/" replace />} />
            <Route path="dashboard"       element={<Navigate to="/" replace />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
