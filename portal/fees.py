"""Fee pages of the student portal: dues, installments, challans,
transactions and receipts. Every lookup is scoped to g.student, so a
student can only ever open their own challans and receipts."""
from flask import Blueprint, abort, flash, g, redirect, request, url_for

from erp import fees as data
from portal.common import login_required, render_page

bp = Blueprint("fees", __name__, url_prefix="/fee")

bp.app_template_filter("fee_inr")(data.format_inr)
bp.app_template_filter("fee_words")(data.amount_in_words)

INSTALLMENT_CHIPS = {"Paid": "ok", "Overdue": "bad", "Partially paid": "warn", "Pending": ""}


@bp.route("/")
@login_required
def index():
    sid = g.student["id"]
    heads = data.fee_heads(sid)
    semesters = {}
    for h in heads:
        semesters.setdefault(h["semester"], []).append(h)
    return render_page("portal/fees/index.html", active="fee", tab="index",
                       semesters=semesters, summary=data.dues_summary(sid),
                       options=data.payment_options(sid), demo_mode=data.DEMO_MODE)


@bp.route("/pay", methods=["POST"])
@login_required
def pay():
    payment_id = data.pay_demo(g.student["id"], request.form.get("option", ""))
    if payment_id is None:
        flash("Nothing to pay for that option. Your dues may already be cleared.", "error")
        return redirect(url_for("fees.index"))
    flash("Demo payment recorded. No real money was charged.", "info")
    return redirect(url_for("fees.receipt", payment_id=payment_id))


@bp.route("/installments")
@login_required
def installments():
    plan = data.installments(g.student["id"])
    return render_page("portal/fees/installments.html", active="fee", tab="installments",
                       plan=plan, chips=INSTALLMENT_CHIPS,
                       cleared=sum(1 for i in plan if i["status"] == "Paid"),
                       overdue=sum(i["balance"] for i in plan if i["status"] == "Overdue"))


@bp.route("/challan", methods=["GET", "POST"])
@login_required
def challan():
    sid = g.student["id"]
    if request.method == "POST":
        challan_id = data.create_challan(sid, request.form.get("option", ""), request.form.get("bank", ""))
        if challan_id is None:
            flash("Please choose a valid amount and bank.", "error")
            return redirect(url_for("fees.challan"))
        return redirect(url_for("fees.challan_view", challan_id=challan_id))
    return render_page("portal/fees/challan.html", active="fee", tab="challan",
                       options=data.payment_options(sid), banks=data.BANKS,
                       challans=data.list_challans(sid), valid_days=data.CHALLAN_VALID_DAYS)


@bp.route("/challan/<int:challan_id>")
@login_required
def challan_view(challan_id):
    row = data.get_challan(g.student["id"], challan_id)
    if row is None:
        abort(404)
    return render_page("portal/fees/challan_view.html", active="fee", tab="challan", challan=row)


@bp.route("/transactions")
@login_required
def transactions():
    payments = data.list_payments(g.student["id"])
    return render_page("portal/fees/transactions.html", active="fee", tab="transactions",
                       payments=payments,
                       total_paid=sum(p["amount"] for p in payments if p["status"] == "Success"))


@bp.route("/receipt/<int:payment_id>")
@login_required
def receipt(payment_id):
    found = data.get_receipt(g.student["id"], payment_id)
    if found is None:
        abort(404)
    payment, items = found
    return render_page("portal/fees/receipt.html", active="fee", tab="transactions",
                       payment=payment, items=items)
