'use strict';
// Paystack sends shoppers back to /order.html?ref=...; hand over to the storefront's order page.
const ref = new URLSearchParams(location.search).get('ref');
location.replace(ref && /^[A-Za-z0-9]+$/.test(ref) ? '/#/order/' + ref : '/');
