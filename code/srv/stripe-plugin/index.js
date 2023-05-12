/**
 * WARNING: This Stripe Integration is a work in progress and it does not work properly yet.
 * Relevant documentation and community will be updated when it's ready to use! Please do not use this!
 */
const cds = require("@sap/cds");
const express = require("express");
const stripe = require("stripe")(process.env.stripeKey);
const secret = process.env.stripeWebhookSecret
class Stripe extends cds.Service {
    async init() {
        this.registerStripeWebhookEndpoint();
        await this.registerProvisioningEvents();
        await super.init();
    }

    /**
     * Searches for all customers associated with tenants that have the "susaasTenant" metadata key set to true.
     *
     * @async
     * @function getAllCustomers
     * @returns {Promise<Object>} A promise that resolves with an object containing the matching customers found in Stripe.
     * @throws {Error} If there was an error searching for customers in Stripe.
     */
    async getAllCustomers() {
        try {
            return await stripe.customers.search({
                query: `'metadata[\'susaasTenant\']:true`,
            });
        } catch (error) {
            console.log(`[stripe]-Customers can not be retrieved`);
        }
    }

    /**
     * Gets customer from Stripe with SAP BTP Tenant ID
     *
     * @async
     * @function getAllCustomers
     * @returns {Promise<Object>} A promise that resolves with an object containing the matching customers found in Stripe.
     * @throws {Error} If there was an error searching for customers in Stripe.
     */
    async getCustomer(tenant) {
        try {
            let customer = await stripe.customers.search({
                query: `metadata[\'tenant\']:\'${tenant}\'`,
            });
            return customer.data[0];
        } catch (error) {
            console.log(`[stripe]-Customers can not be retrieved`);
        }
    }

    /**
     * Creates a new customer object in Stripe and logs the result to the console.
     *
     * @async
     * @function createCustomer
     * @param {Object} options - An object containing the following properties:
     * @param {string} options.tenant - The ID of the tenant to associate with the customer.
     * @param {string} options.subdomain - The subdomain of the customer.
     * @param {string} options.email - The email address of the customer.
     * @returns {Promise<void>} A promise that resolves once the customer is created in Stripe.
     * @throws {Error} If there was an error creating the customer in Stripe.
     */
    async createCustomer({ tenant, subdomain, email }) {
        try {
            return await stripe.customers.create({
                name: `Customer for SusaaS ${subdomain}`,
                email: email,
                description: `Customer with subdomain ${subdomain}, subscribed by ${email}, subscribed at ${new Date().toLocaleDateString()}-${new Date().toLocaleTimeString()}`,
                metadata: {
                    susaasTenant: true,
                    tenant: tenant,
                    subdomain: subdomain
                },
            });
        } catch (error) {
            console.log(`[stripe]-Customer ${subdomain}, can not be created:`, error.message);
        }
    }

    /**
     * Deletes a customer object from Stripe.
     *
     * @async
     * @function deleteCustomer
     * @param {string} tenant - The ID of the tenant associated with the customer to be deleted.
     * @returns {Promise<void>} A promise that resolves once the customer is deleted from Stripe.
     * @throws {Error} If there was an error deleting the customer in Stripe.
     */
    async deleteCustomer(tenant) {
        try {
            // Improvement -> Subscription remove customer remains.
            let customer = await this.getCustomer(tenant);
            await stripe.customers.del(customer.id);
        } catch (error) {
            console.log(`[stripe]-Customer ${tenant} can not be deleted:${error.message}`);
        }
    }

    /**
     * Retrieves a list of subscriptions from Stripe.
     *
     * @async
     * @function getSubscriptions
     * @param {Object} options - An object containing the following properties:
     * @param {string} options.tenant - The ID of the tenant to retrieve subscriptions for. Optional.
     * @returns {Promise<Object>} A promise that resolves with an object containing the subscriptions retrieved from Stripe.
     * @throws {Error} If there was an error retrieving subscriptions from Stripe.
     */
    async getSubscriptions(tenant) {
        try {
            let customer = await this.getCustomer(tenant);
            return await stripe.subscriptions.list({
                limit: 50,
                price: this.options.priceId,
                customer: customer.customerId,
            });
        } catch (error) {
            console.log(`[stripe]-Subscriptions can not be retrieved`);
        }
    }

    /**
     * Creates a subscription for a given tenant ID in Stripe.
     *
     * @async
     * @function createSubscription
     * @param {string} stripeCustomerid - The ID of the tenant to create a subscription for.
     * @returns {Promise<void>} A promise that resolves with no value if the subscription was created successfully.
     * @throws {Error} If there was an error creating the subscription in Stripe.
     */
    async createSubscription(stripeCustomerId) {
        try {
            let priceArray = this.options.prices.map((priceValue) => ({ price: priceValue }))
            let subscriptionConfig = {
                customer: stripeCustomerId,
                items: priceArray,
                collection_method: 'send_invoice',
                days_until_due: this.options.daysUntilDue ? this.options.daysUntilDue : 30,
            };
            if (this.options.trialDays) {
                let today = new Date();
                let trial_end = today.setDate(
                    today.getDate() + this.options.trialDays
                );
                trial_end = Math.floor(trial_end / 1000);
                subscriptionConfig.trial_end = trial_end;
            }
            let response = await stripe.subscriptions.create(
                subscriptionConfig
            );
            console.log("[stripe]-Subscription has been created.")
            return response;

        } catch (error) {
            console.log(`[stripe] - Subscription can not be created for customer :`, error.message);
        }
    }

    /**
     * Upgrades a subscription for a given tenant ID in Stripe from trial to paid.
     *
     * @async
     * @function upgradeSubscription
     * @param {Object} options - The options to use when upgrading the subscription and finishing the trial
     * @param {string} options.tenant - The ID of the tenant to upgrade the subscription for.
     * @returns {Promise<void>} A promise that resolves with no value if the subscription was upgraded successfully.
     * @throws {Error} If there was an error upgrading the subscription in Stripe.
     */
    async upgradeSubscription(tenant) {
        try {
            const subscriptions = await this.getSubscriptions(tenant);
            let subscriptionId = subscriptions.data[0].id;
            await stripe.subscriptions.update(subscriptionId, { trial_end: "now" });
        } catch (error) {
            console.log(
                `[stripe] - Subscription can not be upgraded for customer ${tenant}:`, error.message
            );
        }
    }

    /**
     * Cancels a subscription in Stripe for a given tenant ID.
     *
     * @async
     * @function cancelSubscription
     * @param {string} tenant - The ID of the tenant whose subscription should be canceled.
     * @returns {Promise<void>} A promise that resolves with no value if the subscription was canceled successfully.
     * @throws {Error} If there was an error canceling the subscription in Stripe.
     */

    async cancelSubscription(tenant) {
        try {
            let subscriptions = await this.getSubscriptions(tenant);
            let subscriptionId = subscriptions.data[0].id;
            await stripe.subscriptions.del(subscriptionId);
        } catch (error) {
            console.log(
                `[stripe] - Subscription can not be cancelled for customer : ${tenant}`
            );
        }
    }

    /**
     * Cancels a subscription in Stripe for a given tenant ID.
     *
     * @async
     * @function cancelSubscription
     * @param {string} tenant - The ID of the tenant whose subscription should be canceled.
     * @returns {Promise<void>} A promise that resolves with no value if the subscription was canceled successfully.
     * @throws {Error} If there was an error canceling the subscription in Stripe.
     */

    async createCustomerPortal(stripeCustomerId) {

        const configuration = await stripe.billingPortal.configurations.create({
            business_profile: {
                headline: 'Sustainable SaaS - TFE Demo',
            },
            features: {
                invoice_history: { enabled: true },
                payment_method_update: { enabled: true },
                customer_update: {
                    enabled: true,
                    allowed_updates: [
                        "email",
                        "name",
                        "address",
                        "phone"
                    ]
                }
            },
        });
        return configuration;
    }

    async redirectCustomerPortal(returnUrl) {
        let customer = await this.getCustomer(cds.context?.tenant);
        const session = await stripe.billingPortal.sessions.create({
            customer: customer.id,
            return_url: returnUrl,
        });
        return session;
    }

    async handleStripeWebhookEvent(req, res) {
        const event = this.validateSignature(req, res)
        // Handle the event
        switch (event.type) {
            case 'customer.subscription.updated':
                const paymentIntent = event.data.object;
                console.log("[stripe]-Customer Plan is updated..")
                break;
            case 'customer.subscription.trial_will_end':
                const paymentMethod = event.data.object;
                console.log("[stripe]-Customers trial will end")
                break;
            default:
                console.log(`[stripe]- Unhandled event type ${event.type}`);
        }
        res.json({ received: true });
    }

    registerStripeWebhookEndpoint() {
        try {
            cds.app.post('/stripe/webhook', express.raw({ type: 'application/json' }), this.handleStripeWebhookEvent.bind(this));
        } catch (error) {
            console.error("[stripe] - Webhook endpoints are not registered.")
        }
    }

    validateSignature(req, res) {
        const signature = req.headers['stripe-signature'];
        try {
            let event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                secret,
            );
            return event;
        } catch (err) {
            console.log(`[stripe] - ⚠️  Webhook signature verification failed.`, err.message);
            return res.sendStatus(400);
        }
    }

    async registerProvisioningEvents() {
        const provisioning = await cds.connect.to('cds.xt.SaasProvisioningService')
        if(provisioning){
            await provisioning.prepend(() => {
                provisioning.before('UPDATE', 'tenant', async (req) => {
                    const { subscribedSubdomain: subdomain, subscribedTenantId: tenant, userId: email } = req.data;
                    let customer = await this.createCustomer({ tenant: tenant, subdomain: subdomain, email: email })
                    await this.createSubscription(customer.id);
                })
                provisioning.before('DELETE', 'tenant', async (req) => {
                    await this.deleteCustomer(req.data.tenant);
                })
            })
        }

    }
}


module.exports = Stripe;