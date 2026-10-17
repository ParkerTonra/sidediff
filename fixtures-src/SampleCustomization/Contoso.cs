// Synthetic customization classes for the assembly browser tests: a graph, a
// graph extension, a DAC, a DAC extension, a custom attribute, string literals,
// and a method with a loop and a switch. VARIANT_B (the B build) changes one
// literal, one DisplayName and adds a method, so compare mode has real diffs.
using System;
using System.Collections.Generic;
using PX.Data;

namespace Contoso.Extensions
{
    /// <summary>A DAC.</summary>
    [PXCacheName("Contoso Route")]
    public class ContosoRoute : IBqlTable
    {
        [PXDBString(15, IsUnicode = true)]
        [PXUIField(DisplayName = "Route Code")]
        public virtual string RouteCode { get; set; }

        [PXDBString(60, IsUnicode = true)]
#if VARIANT_B
        [PXUIField(DisplayName = "Route Description")]
#else
        [PXUIField(DisplayName = "Description")]
#endif
        public virtual string Description { get; set; }

        [PXDBDecimal(2)]
        [PXUIField(DisplayName = "Max Weight")]
        public virtual decimal? MaxWeight { get; set; }
    }

    /// <summary>A DAC extension.</summary>
    public sealed class ContosoRouteExt : PXCacheExtension<ContosoRoute>
    {
        [PXDBString(30)]
        [PXUIField(DisplayName = "Carrier Account")]
        public string UsrCarrierAccount { get; set; }
    }

    /// <summary>A custom attribute.</summary>
    public class RouteCodeAttribute : PXEventSubscriberAttribute
    {
        public const string Prefix = "RT-";

        public string Normalize(string value) => string.IsNullOrEmpty(value) ? value : Prefix + value.Trim().ToUpperInvariant();
    }

    /// <summary>A graph.</summary>
    public class ContosoRouteMaint : PXGraph<ContosoRouteMaint>
    {
        public const string AuditMessage = "CONTOSO-ROUTE-AUDIT-7731";

        public List<ContosoRoute> Routes { get; } = new List<ContosoRoute>();

        public override void Persist()
        {
            PXTrace.WriteInformation(AuditMessage);
            base.Persist();
        }

        /// <summary>Loop and switch, for the IL view and the decompiler.</summary>
        public decimal TotalWeight(string mode)
        {
            decimal total = 0m;
            foreach (ContosoRoute route in Routes)
            {
                switch (mode)
                {
                    case "max":
                        total = Math.Max(total, route.MaxWeight ?? 0m);
                        break;
                    case "sum":
                        total += route.MaxWeight ?? 0m;
                        break;
                    case "count":
                        total += 1m;
                        break;
                    default:
                        throw new PXException("Unknown weight mode: " + mode);
                }
            }
            return total;
        }
    }

    /// <summary>A graph extension.</summary>
    public class ContosoRouteMaintExt : PXGraphExtension<ContosoRouteMaint>
    {
#if VARIANT_B
        public const string Greeting = "Route maintenance v2 ready";
#else
        public const string Greeting = "Route maintenance ready";
#endif

        public override void Initialize()
        {
            PXTrace.WriteInformation(Greeting);
        }

        public int CountLongRoutes(int minimumLength)
        {
            int count = 0;
            for (int i = 0; i < Base.Routes.Count; i++)
            {
                string code = Base.Routes[i].RouteCode ?? string.Empty;
                if (code.Length >= minimumLength) count++;
            }
            return count;
        }

#if VARIANT_B
        public bool HasRoute(string code)
        {
            foreach (ContosoRoute route in Base.Routes)
            {
                if (string.Equals(route.RouteCode, code, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
#endif
    }
}
