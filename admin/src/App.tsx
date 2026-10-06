import { Routes, Route } from 'react-router-dom';
import OrderList   from './pages/OrderList';
import OrderDetail from './pages/OrderDetail';

export default function App() {
  return (
    <Routes>
      <Route path="/"           element={<OrderList />} />
      <Route path="/orders/:id" element={<OrderDetail />} />
    </Routes>
  );
}
