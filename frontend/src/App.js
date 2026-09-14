import "@/App.css";
import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/AuthContext";
import { LangProvider } from "@/context/LangContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/Layout";

// Lazy-loaded so each page's JS is only downloaded when a user actually
// visits it, instead of all 9 pages being bundled into one giant upfront
// download on first load.
const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Clients = lazy(() => import("@/pages/Clients"));
const ClientDetail = lazy(() => import("@/pages/ClientDetail"));
const ProcurementLog = lazy(() => import("@/pages/ProcurementLog"));
const ClientSubledger = lazy(() => import("@/pages/ClientSubledger"));
const ProductLedger = lazy(() => import("@/pages/ProductLedger"));
const ProcurementSettlement = lazy(() => import("@/pages/ProcurementSettlement"));
const BackupRestore = lazy(() => import("@/pages/BackupRestore"));

function RouteFallback() {
  return (
    <div className="flex items-center justify-center min-h-[40vh] text-sm text-stone-400">
      Loading…
    </div>
  );
}

function App() {
  return (
    <div className="App">
      <LangProvider>
        <AuthProvider>
          <BrowserRouter>
            <Toaster position="top-right" richColors closeButton />
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                  <Route index element={<Dashboard />} />
                  <Route path="clients" element={<Clients />} />
                  <Route path="clients/:id" element={<ClientDetail />} />
                  <Route path="payments/new" element={<Navigate to="/" replace />} />
                  <Route path="calculate" element={<Navigate to="/" replace />} />
                  <Route path="procurement/log" element={<ProcurementLog />} />
                  <Route path="procurement/client-subledger" element={<ClientSubledger />} />
                  <Route path="procurement/product-ledger" element={<ProductLedger />} />
                  <Route path="procurement/settlement" element={<ProcurementSettlement />} />
                  <Route path="admin/backup" element={<BackupRestore />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </LangProvider>
    </div>
  );
}

export default App;
