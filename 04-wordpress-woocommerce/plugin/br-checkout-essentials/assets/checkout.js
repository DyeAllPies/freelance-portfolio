/* global jQuery */
// The PIX discount depends on the chosen payment method, which WooCommerce
// does not recalculate on its own when the buyer switches methods.
jQuery(function ($) {
  $("form.checkout").on("change", 'input[name="payment_method"]', function () {
    $(document.body).trigger("update_checkout");
  });

  // Masks the CPF as 000.000.000-00 while typing. The server validates it anyway.
  $(document.body).on("input", "#billing_cpf", function () {
    var d = this.value.replace(/\D/g, "").slice(0, 11);
    this.value = d
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
  });
});
