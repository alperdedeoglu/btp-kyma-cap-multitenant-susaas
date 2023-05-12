const cds = require('@sap/cds')
const requires = cds.env.requires ??= {}
if (!requires.commercialization) requires.commercialization = {
  impl: "stripe-plugin"
}
cds.on('served', async () => {
        await cds.connect.to("commercialization");
});