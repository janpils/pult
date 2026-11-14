// Pult: soubory do schránky jako ⌘C ve Finderu (víc souborů najednou), pak ⌘V ve Zprávách nebo Mailu.
// Každý soubor jako vlastní položka s public.file-url, aby ve schránce zůstaly i po skončení procesu.
import AppKit
let paths = CommandLine.arguments.dropFirst()
let pb = NSPasteboard.general
pb.clearContents()
var items: [NSPasteboardItem] = []
for p in paths {
    let it = NSPasteboardItem()
    it.setString(URL(fileURLWithPath: p).absoluteString, forType: .fileURL)
    items.append(it)
}
let ok = pb.writeObjects(items)
pb.setPropertyList(Array(paths), forType: NSPasteboard.PasteboardType("NSFilenamesPboardType"))
print(ok ? "ok" : "fail")
