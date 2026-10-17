// Entry points called from src/assembly/decompiler.worker.ts through [JSExport].
// DECISIONS.md D19.
using System;
using System.IO;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;

[System.Runtime.Versioning.SupportedOSPlatform("browser")]
public static partial class SideDiffDecompiler
{
    // The .NET WebAssembly host needs a Main; the worker only calls the exports.
    public static void Main() { }

    // The type system of the last assembly, by the caller's key: building it
    // reads the whole assembly, so browsing types one by one reuses it.
    private static string? lastKey;
    private static DecompilerTypeSystem? lastTypeSystem;

    /// <summary>C# for one type, by reflection full name (nested types use '+').</summary>
    [JSExport]
    public static async Task<string> DecompileType(byte[] assembly, string key, string typeName)
    {
        var decompiler = await Create(assembly, key);
        return decompiler.DecompileTypeAsString(new FullTypeName(typeName));
    }

    /// <summary>C# for the whole assembly.</summary>
    [JSExport]
    public static async Task<string> DecompileModule(byte[] assembly, string key)
    {
        var decompiler = await Create(assembly, key);
        return decompiler.DecompileWholeModuleAsString();
    }

    private static async Task<CSharpDecompiler> Create(byte[] assembly, string key)
    {
        var settings = new DecompilerSettings { ThrowOnAssemblyResolveErrors = false, LoadInMemory = true };
        if (key == lastKey && lastTypeSystem != null) return new CSharpDecompiler(lastTypeSystem, settings);
        var file = new PEFile("assembly.dll", new MemoryStream(assembly), PEStreamOptions.PrefetchEntireImage);
        // The browser runtime is single-threaded and cannot block (no Monitor.Wait),
        // so the type system is built with the async factory, and references
        // (PX.*, the BCL) resolve to nothing at once: the decompiler then prints
        // fully qualified names, which is fine here.
        var typeSystem = await DecompilerTypeSystem.CreateAsync(file, new NoReferences(), settings);
        lastKey = key;
        lastTypeSystem = typeSystem;
        return new CSharpDecompiler(typeSystem, settings);
    }

    private sealed class NoReferences : IAssemblyResolver
    {
        public MetadataFile? Resolve(IAssemblyReference reference) => null;
        public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => null;
        public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult<MetadataFile?>(null);
        public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult<MetadataFile?>(null);
        public IDisposable BeginSnapshot() => new Nothing();
    }

    private sealed class Nothing : IDisposable
    {
        public void Dispose() { }
    }
}
