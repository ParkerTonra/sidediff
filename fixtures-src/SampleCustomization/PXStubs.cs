// Minimal stand-ins for Acumatica framework types, so the test assembly has the
// same base-type chains as a real customization without referencing PX.*.
// Synthetic; signatures are simplified.
using System;

namespace PX.Data
{
    public interface IBqlTable { }

    public abstract class PXGraph
    {
        public virtual void Persist() { }
    }

    public class PXGraph<TGraph> : PXGraph where TGraph : PXGraph { }

    public abstract class PXGraphExtension
    {
        public virtual void Initialize() { }
    }

    public abstract class PXGraphExtension<TGraph> : PXGraphExtension where TGraph : PXGraph
    {
        public TGraph Base { get; internal set; }
    }

    public abstract class PXCacheExtension : IBqlTable { }

    public abstract class PXCacheExtension<TTable> : PXCacheExtension where TTable : IBqlTable { }

    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter | AttributeTargets.Class, AllowMultiple = true)]
    public abstract class PXEventSubscriberAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter | AttributeTargets.Class)]
    public class PXUIFieldAttribute : PXEventSubscriberAttribute
    {
        public string DisplayName { get; set; }
        public bool Enabled { get; set; } = true;
        public bool Visible { get; set; } = true;
    }

    [AttributeUsage(AttributeTargets.Property)]
    public class PXDBStringAttribute : PXEventSubscriberAttribute
    {
        public PXDBStringAttribute(int length) { Length = length; }
        public int Length { get; }
        public bool IsUnicode { get; set; }
    }

    [AttributeUsage(AttributeTargets.Property)]
    public class PXDBDecimalAttribute : PXEventSubscriberAttribute
    {
        public PXDBDecimalAttribute(int precision) { Precision = precision; }
        public int Precision { get; }
    }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class PXCacheNameAttribute : Attribute
    {
        public PXCacheNameAttribute(string name) { Name = name; }
        public string Name { get; }
    }

    public class PXSetup<TTable> where TTable : class, IBqlTable, new() { }

    public class PXException : Exception
    {
        public PXException(string message) : base(message) { }
    }

    public static class PXTrace
    {
        public static void WriteInformation(string message) { }
    }
}
