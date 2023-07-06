
const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);

const cds = require("@sap/cds");

class RateLimiter extends cds.Service {
   async init() {
      await super.init();
      console.log("[rate-limiter]- Rate Limiter has been initialized!")
   }

   async createRateLimit(url, numberOfReq, timeInterval, tenant) {
      try {
         const response = await this.getEnvoyFilter(`${process.env["HELM_RELEASE"]}-${process.env["KYMA_NAMESPACE"]}`);
         if (!response) {
            await this.createEnvoyFilter(url, numberOfReq, timeInterval, tenant)
         } else {
            let filter = response.body;
            await this.patchEnvoyFilter(filter, url, numberOfReq, timeInterval, tenant)
         }
      } catch (error) {
         console.error("[rate-limiter]- Rate Limiting can not be activated for tenant:", tenantId, error.message);
      }
   }

   async createEnvoyFilter(url, numberOfReq, timeInterval, tenant) {

      try {
         const envoyFilter = _createEnvoyFilterTemplate({ ...this.options });
         const envoyFilterConfigPatch = _createEnvoyFilterConfigPatch(url, numberOfReq, timeInterval, tenant)
         envoyFilter.spec.configPatches.push(envoyFilterConfigPatch);
         await k8sApi.createNamespacedCustomObject("networking.istio.io", "v1alpha3", "istio-system", "envoyfilters", envoyFilter);
         console.log(`[rate-limiter]- Rate Limiter has been initialized for \n \t \t url:${url} \n \t \t ${numberOfReq}/${timeInterval}/instance`)
      } catch (error) {
         if (error.statusCode === '409') {
            console.log("[rate-limiter]- Object already exists, skipped creation.")
         } else {
            console.log(`Object can not be created -> ${error.message}`)
         }

      }
   }

   async deleteEnvoyFilter(name) {
      try {
         let response = await k8sApi.deleteNamespacedCustomObject("networking.istio.io", "v1alpha3", "istio-system", "envoyfilters", name)
         console.log(`[rate-limiter]- Rate Limiter has been deleted for tenant: ${tenantId}`)
      } catch (error) {
         console.log("Can not be deleted");
      }
   }

   async getEnvoyFilter(name) {
      try {
         return await k8sApi.getNamespacedCustomObject("networking.istio.io", "v1alpha3", "istio-system", "envoyfilters", name)
      } catch (error) {
         console.info((`[rate-limiter]- Envoy filter can not be found, this is probably the first tenant...`))
         return;
      }
   }

   removeTenantConfigPatch(tenant, filter) {
      let index = filter.spec.configPatches.findIndex((configPatch) => {
         if (configPatch.patch.value.typed_per_filter_config) {
            let headers = configPatch.patch.value.typed_per_filter_config["envoy.filters.http.local_ratelimit"].value.response_headers_to_add;
            let tenantHeader = headers.some((headerConfig) => {
               if (headerConfig.header.key === 'tenant' && headerConfig.header.value === tenant) {
                  return headerConfig
               }
            })
            if (tenantHeader) {
               return configPatch
            }
         }
      })
      filter.spec.configPatches.splice(index, 1);
      return filter.spec.configPatches;
   }

   async patchEnvoyFilter(filter, url, numberOfReq, timeInterval, tenant) {
      const configPatch = _createEnvoyFilterConfigPatch(url, numberOfReq, timeInterval, tenant)
      filter.spec.configPatches.push(configPatch);
      const patch = [
         {
            "op": "replace",
            "path": "/spec",
            "value": {
               "configPatches": filter.spec.configPatches
            }
         }
      ];
      const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH } };
      await k8sApi.patchNamespacedCustomObject("networking.istio.io", "v1alpha3", "istio-system", "envoyfilters", filter.metadata.name, patch, undefined, undefined, undefined, options)
      console.log("[rate-limiter] - Rate Limiting is added for:", url)
   }


   async disableRateLimiting(tenant) {
      try {
         let response = await this.getEnvoyFilter(`${process.env["HELM_RELEASE"]}-${process.env["KYMA_NAMESPACE"]}`)
         let filter = response.body;
         let configPatches = response.body.spec.configPatches;
         if(configPatches.length == 2){
           return  await this.deleteEnvoyFilter(`${process.env["HELM_RELEASE"]}-${process.env["KYMA_NAMESPACE"]}`)
         }
         let configPatchNew = this.removeTenantConfigPatch(tenant,filter)
         const patch = [
            {
               "op": "replace",
               "path": "/spec",
               "value": {
                  "configPatches": configPatchNew
               }
            }
         ];
         const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH } };
         await k8sApi.patchNamespacedCustomObject("networking.istio.io", "v1alpha3", "istio-system", "envoyfilters", filter.metadata.name, patch, undefined, undefined, undefined, options)
      } catch (error) {
         console.log("[rate-limiter] - Rate Limiting can not be disabled.")
      }
   }
}

const _createEnvoyFilterTemplate = (options) => {
   return {
      apiVersion: "networking.istio.io/v1alpha3",
      kind: "EnvoyFilter",
      metadata: {
         name: `${process.env["HELM_RELEASE"]}-${process.env["KYMA_NAMESPACE"]}`,
         namespace: options.namespace ? options.namespace : "istio-system"
      },
      spec: {
         workloadSelector: {
            labels: {
               istio: "ingressgateway"
            }
         },
         configPatches: [{
            applyTo: "HTTP_FILTER",
            match: {
               context: "GATEWAY",
               listener: {
                  filterChain: {
                     filter: {
                        name: "envoy.filters.network.http_connection_manager"
                     }
                  }
               }
            },
            patch: {
               operation: "INSERT_BEFORE",
               value: {
                  name: "envoy.filters.http.local_ratelimit",
                  typed_config: {
                     "@type": "type.googleapis.com/udpa.type.v1.TypedStruct",
                     "type_url": "type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit",
                     "value": {
                        "stat_prefix": "http_local_rate_limiter"
                     }
                  }
               }
            }
         }]
      }
   }
}
const _createEnvoyFilterConfigPatch = (url, numberOfReq, timeInterval, tenant) => {
   const tenantUrl = new URL(url);
   return {
      applyTo: "VIRTUAL_HOST",
      match: {
         context: "GATEWAY",
         routeConfiguration: {
            vhost: {
               name: `${tenantUrl.host}:443`,
               route: {
                  action: "ANY"
               }
            }
         }
      },
      patch: {
         operation: "MERGE",
         value: {
            typed_per_filter_config: {
               "envoy.filters.http.local_ratelimit": {
                  "@type": "type.googleapis.com/udpa.type.v1.TypedStruct",
                  type_url: "type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit",
                  value: {
                     stat_prefix: "http_local_rate_limiter",
                     token_bucket: {
                        max_tokens: numberOfReq,
                        tokens_per_fill: numberOfReq,
                        fill_interval: timeInterval ? timeInterval : "60s"
                     },
                     filter_enabled: {
                        runtime_key: "local_rate_limit_enabled",
                        default_value: {
                           numerator: 100,
                           denominator: "HUNDRED"
                        }
                     },
                     filter_enforced: {
                        runtime_key: "local_rate_limit_enforced",
                        default_value: {
                           numerator: 100,
                           denominator: "HUNDRED"
                        }
                     },
                     response_headers_to_add: [
                        {
                           append: false,
                           header: {
                              key: "x-local-rate-limit",
                              value: "true",
                              key: "tenant",
                              value: tenant
                           }
                        }
                     ]
                  }
               }
            }
         }
      }
   }


}

module.exports = RateLimiter;

