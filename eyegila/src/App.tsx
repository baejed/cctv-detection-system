import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ReportsPage } from './pages/Reports';
import { CamerasPage } from './pages/Cameras';
import { CameraDetailPage } from './pages/CameraDetail';
import { IntersectionsPage } from './pages/Intersections';
import { VideosPage } from './pages/Videos';
import { RecommendationsPage } from './pages/Recommendations';
import { UsersPage } from './pages/Users';
import { ManualPage } from './pages/Manual';
import { SignalTimingPage } from './pages/SignalTiming';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="cameras" element={<CamerasPage />} />
            <Route path="cameras/:id" element={<CameraDetailPage />} />
            <Route path="intersections" element={<IntersectionsPage />} />
            <Route path="videos" element={<VideosPage />} />
            <Route path="videos/:id" element={<VideosPage />} />
            <Route path="recommendations" element={<RecommendationsPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="manual" element={<ManualPage />} />
            <Route path="timing/:id" element={<SignalTimingPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
