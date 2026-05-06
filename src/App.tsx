import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DeviceCheckPage } from './pages/DeviceCheckPage'
import { HapticsPairingPage } from './pages/HapticsPairingPage'
import { HapticsTesterPage } from './pages/HapticsTesterPage'
import { HomePage } from './pages/HomePage'

function routerBasename(): string | undefined {
  const base = import.meta.env.BASE_URL
  if (base === '/') return undefined
  return base.replace(/\/$/, '')
}

export default function App() {
  return (
    <BrowserRouter basename={routerBasename()}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="device" element={<DeviceCheckPage />} />
          <Route path="tester" element={<HapticsTesterPage />} />
          <Route path="pairing" element={<HapticsPairingPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
