import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/AuthContext";
import { LangProvider } from "@/context/LangContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Clients from "@/pages/Clients";
import ClientDetail from "@/pages/ClientDetail";
import AddPayment from "@/pages/AddPayment";
import ProcurementLog from "@/pages/ProcurementLog";
import ClientSubledger from "@/pages/ClientSubledger";
import ProductLedger from "@/pages/ProductLedger";
import ProcurementSettlement from "@/pages/ProcurementSettlement";
function App() {
  return (
    <div className="App">
      <LangProvider>
        <AuthProvider>
          <BrowserRouter>
            <Toaster position="top-right" richColors closeButton />
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
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </LangProvider>
    </div>
  );
}

export default App;
