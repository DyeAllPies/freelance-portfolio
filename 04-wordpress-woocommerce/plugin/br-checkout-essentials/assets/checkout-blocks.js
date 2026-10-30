/* global wp, wc, brceBlocks */
// The block checkout keeps the chosen payment method in the browser and does
// not recalculate the totals when it changes, so the PIX discount line would
// not follow a switch. Each change is sent to the server, which answers with
// the cart's new totals.
(function () {
  var data = wp.data;
  var update = wc.blocksCheckout.extensionCartUpdate;
  var settings = window.brceBlocks || {};
  var last = null;
  data.subscribe(function () {
    var payment = data.select("wc/store/payment");
    var method = payment && payment.getActivePaymentMethod();
    if (!method || method === last) return;
    var first = last === null;
    last = method;
    if (first) {
      // The server already priced the cart for the method selected by
      // default. An update answers with the cart, which clears the fields the
      // buyer has started typing, so it is sent only when the prices disagree.
      var fees = data.select("wc/store/cart").getCartData().fees || [];
      var hasDiscount = fees.some(function (fee) {
        return fee.name === settings.pixLabel;
      });
      if (hasDiscount === (method === settings.pixGateway)) return;
    }
    update({ namespace: "brce-payment-method", data: { payment_method: method } });
  });
})();
