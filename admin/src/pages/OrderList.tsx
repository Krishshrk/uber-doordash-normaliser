import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { fetchOrders } from '../api';
import { formatMoney } from '../types';
import type { Order, OrderStatus } from '../types';

const PROVIDERS = ['uber', 'doordash'] as const;
const STATUSES: OrderStatus[] = ['new','accepted','ready','completed','canceled','rejected'];

export default function OrderList() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const provider = params.get('provider') ?? '';
  const status   = params.get('status')   ?? '';
  const search   = params.get('search')   ?? '';
  const sort     = params.get('sort')     ?? 'desc';

  const { data: orders, isLoading, isError } = useQuery({
    queryKey: ['orders'],
    queryFn:  fetchOrders,
  });

  function set(key: string, value: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
  }

  const filtered: Order[] = (orders ?? [])
    .filter((o) => !provider || o.provider === provider)
    .filter((o) => !status   || o.status   === status)
    .filter((o) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return o.customer.toLowerCase().includes(q) || o.external_order_id.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return sort === 'asc' ? diff : -diff;
    });

  function openOrder(id: string) {
    navigate(`/orders/${id}?${params.toString()}`);
  }

  return (
    <div className="page">
      <h1>Kitchen Orders</h1>

      <div className="filters" role="search">
        <select aria-label="Filter by provider" value={provider} onChange={(e) => set('provider', e.target.value)}>
          <option value="">All providers</option>
          {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select aria-label="Filter by status" value={status} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <input
          type="search"
          aria-label="Search by customer or order ID"
          placeholder="Customer or order ID…"
          value={search}
          onChange={(e) => set('search', e.target.value)}
        />

        <select aria-label="Sort by time" value={sort} onChange={(e) => set('sort', e.target.value)}>
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </div>

      {isLoading && <p className="state-msg">Loading orders…</p>}
      {isError   && <p className="state-msg error">Failed to load orders. Is the API running?</p>}

      {!isLoading && !isError && filtered.length === 0 && (
        <p className="state-msg">No orders match your filters.</p>
      )}

      {filtered.length > 0 && (
        <table role="grid" aria-label="Orders">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Total</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => (
              <tr
                key={o.id}
                tabIndex={0}
                role="row"
                className="clickable-row"
                onClick={() => openOrder(o.id)}
                onKeyDown={(e) => e.key === 'Enter' && openOrder(o.id)}
                aria-label={`Order ${o.external_order_id} from ${o.customer}`}
              >
                <td><span className={`badge badge-${o.provider}`}>{o.provider}</span></td>
                <td className="mono">{o.external_order_id}</td>
                <td>{o.customer}</td>
                <td><span className={`badge badge-status badge-${o.status}`}>{o.status}</span></td>
                <td>{formatMoney(o.total_cents, o.currency)}</td>
                <td>{new Date(o.created_at).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
