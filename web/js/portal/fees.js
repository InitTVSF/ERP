/* Fee pages of the student portal: dues, installments, challans,
 * transactions and receipts. Port of portal/fees.py. Every lookup is scoped
 * to g.student, so a student can only ever open their own challans and receipts. */
import { Blueprint, abort, flash, g, redirect, request, url_for } from "../lib/flask.js";
import * as data from "../erp/fees.js";
import { login_required, render_page } from "./common.js";

export const bp = new Blueprint("fees", { url_prefix: "/fee" });

bp.app_template_filter("fee_inr", data.format_inr);
bp.app_template_filter("fee_words", data.amount_in_words);

const INSTALLMENT_CHIPS = { "Paid": "ok", "Overdue": "bad", "Partially paid": "warn", "Pending": "" };

bp.route("/", login_required(function index() {
  const sid = g.student.id;
  const heads = data.fee_heads(sid);
  const semesters = {};
  for (const h of heads) (semesters[h.semester] ??= []).push(h);
  return render_page("portal/fees/index.html", "fee", { tab: "index",
    semesters, summary: data.dues_summary(sid),
    options: data.payment_options(sid), demo_mode: data.DEMO_MODE });
}));

bp.route("/pay", { methods: ["POST"] }, login_required(function pay() {
  const payment_id = data.pay_demo(g.student.id, request.form.get("option", ""));
  if (payment_id === null) {
    flash("Nothing to pay for that option. Your dues may already be cleared.", "error");
    return redirect(url_for("fees.index"));
  }
  flash("Demo payment recorded. No real money was charged.", "info");
  return redirect(url_for("fees.receipt", { payment_id }));
}));

bp.route("/installments", login_required(function installments() {
  const plan = data.installments(g.student.id);
  return render_page("portal/fees/installments.html", "fee", { tab: "installments",
    plan, chips: INSTALLMENT_CHIPS,
    cleared: plan.filter((i) => i.status === "Paid").length,
    overdue: plan.filter((i) => i.status === "Overdue").reduce((a, i) => a + i.balance, 0) });
}));

bp.route("/challan", { methods: ["GET", "POST"] }, login_required(function challan() {
  const sid = g.student.id;
  if (request.method === "POST") {
    const challan_id = data.create_challan(sid, request.form.get("option", ""), request.form.get("bank", ""));
    if (challan_id === null) {
      flash("Please choose a valid amount and bank.", "error");
      return redirect(url_for("fees.challan"));
    }
    return redirect(url_for("fees.challan_view", { challan_id }));
  }
  return render_page("portal/fees/challan.html", "fee", { tab: "challan",
    options: data.payment_options(sid), banks: data.BANKS,
    challans: data.list_challans(sid), valid_days: data.CHALLAN_VALID_DAYS });
}));

bp.route("/challan/<int:challan_id>", login_required(function challan_view({ challan_id }) {
  const row = data.get_challan(g.student.id, challan_id);
  if (row === null) abort(404);
  return render_page("portal/fees/challan_view.html", "fee", { tab: "challan", challan: row });
}));

bp.route("/transactions", login_required(function transactions() {
  const payments = data.list_payments(g.student.id);
  return render_page("portal/fees/transactions.html", "fee", { tab: "transactions",
    payments,
    total_paid: payments.filter((p) => p.status === "Success").reduce((a, p) => a + p.amount, 0) });
}));

bp.route("/receipt/<int:payment_id>", login_required(function receipt({ payment_id }) {
  const found = data.get_receipt(g.student.id, payment_id);
  if (found === null) abort(404);
  const [payment, items] = found;
  return render_page("portal/fees/receipt.html", "fee", { tab: "transactions", payment, items });
}));
