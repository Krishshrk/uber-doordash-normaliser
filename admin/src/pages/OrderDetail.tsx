import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchOrder, patchStatus } from '../api';
import { formatMoney, nextStatuses } from '../types';
import type { OrderStatus } from '../types';

export default function OrderDetail() {
  const { id }      = useParams<{ id: string }>();
  const [params]    = useSearchParams();
  const navigate    = useNavigate();
  const queryClient = useQueryClient();

  const { data: order, isLoading, isError } = useQuery({
    queryKey:        ['order', id],
    queryFn:         () => fetchOrder(id!),
    enabled:         !!id,
    refetchInterval: 15_000,
  });

  const mutation = useMutation({
    mutationFn: (status: OrderStatus) => patchStatus(id!, status),
    onSuccess: () => {
      // Update both caches in place — list does not remount
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  function goBack() {
    navigate(`/?${params.toString()}`);
  }

  // Loading and error states both provide a back button — no dead ends
  if (isLoading) return (
    <div className="page">
      <button className="back-btn" onClick={goBack}>← Back to orders</button>
      <p className="state-msg">Loading…</p>
    </div>
  );

  if (isError || !order) return (
    <div className="page">
      <button className="back-btn" onClick={goBack}>← Back to orders</button>
      <p className="state-msg error">Order not found.</p>
    </div>
  );

  const next = nextStatuses(order.status);

  // Subtotal derived from line items; total_cents is the authoritative figure from the provider
  const lineSubtotal = order.line_items.reduce(
    (sum, item) => sum + item.unit_price_cents * item.quantity, 0
  );

  return (
    <div className="page detail">
      <button className="back-btn" onClick={goBack}>← Back to orders</button>

      <div className="detail-header">
        <span className={`badge badge-${order.provider}`}>{order.provider}</span>
        <h2>{order.customer}</h2>
        <span className="mono">{order.external_order_id}</span>
      </div>

      {/* Status — shown as a labelled field, not just a header badge */}
      <div className="detail-status">
        <span className="detail-label">Status</span>
        <span className={`badge badge-${order.status}`}>{order.status}</span>
      </div>

      {/* Line items */}
      <table className="items-table" aria-label="Line items">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit price</th>
            <th>Line total</th>
          </tr>
        </thead>
        <tbody>
          {order.line_items.map((item, i) => (
            <tr key={i}>
              <td>{item.name}</td>
              <td>{item.quantity}</td>
              <td>{formatMoney(item.unit_price_cents, order.currency)}</td>
              <td>{formatMoney(item.unit_price_cents * item.quantity, order.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {/* Subtotal row only shown when it differs from total (e.g. tax/fees added) */}
          {lineSubtotal !== order.total_cents && (
            <tr>
              <td colSpan={3}>Items subtotal</td>
              <td>{formatMoney(lineSubtotal, order.currency)}</td>
            </tr>
          )}
          <tr className="total-row">
            <td colSpan={3}><strong>Total</strong></td>
            <td><strong>{formatMoney(order.total_cents, order.currency)}</strong></td>
          </tr>
        </tfoot>
      </table>

      {/* Forward-only status advance */}
      {next.length > 0 && (
        <div className="status-actions">
          <span className="detail-label">Advance to:</span>
          {next.map((s) => (
            <button
              key={s}
              className={s === 'canceled' || s === 'rejected' ? 'btn-cancel' : 'btn-advance'}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(s)}
            >
              {s}
            </button>
          ))}
          {mutation.isError && <p className="error">Failed to update status.</p>}
        </div>
      )}

      {/* Raw data — cents and marketplace JSON only here, never above */}
      <details className="debug">
        <summary>Debug — raw data</summary>
        <dl className="debug-fields">
          <dt>total_cents</dt><dd>{order.total_cents}</dd>
          <dt>line_items (raw cents)</dt>
          <dd>
            {order.line_items.map((item, i) => (
              <div key={i}>{item.name}: {item.unit_price_cents} × {item.quantity}</div>
            ))}
          </dd>
        </dl>
        <pre>{JSON.stringify(order.raw_payload, null, 2)}</pre>
      </details>
    </div>
  );
}
