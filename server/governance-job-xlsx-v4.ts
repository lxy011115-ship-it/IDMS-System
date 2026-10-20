import {DomainError} from './service.ts';
import type {Row} from './imports.ts';
import {validateHeaders} from './import-mapping.ts';
// Same restricted workbook rules as the existing importer; no legacy module startup side effects.
function inspectZip(buffer: Buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new DomainError(415, "不是有效XLSX文件");
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16), expanded = 0;
  if (count > 1000 || count === 65535) throw new DomainError(413, "Excel包含过多归档项目");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new DomainError(415, "Excel归档目录无效");
    expanded += buffer.readUInt32LE(offset + 24);
    const length = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + length).toString("utf8");
    if (/vbaProject|externalLinks/i.test(name) || name.includes("..")) throw new DomainError(415, "不允许宏或外部链接");
    if (expanded > 50 * 1024 * 1024) throw new DomainError(413, "Excel展开内容超过50 MiB");
    offset += 46 + length + extra + comment;
  }
}
export async function parseGovernanceXlsxV4(buffer: Buffer,mapped=false): Promise<{ rows: Row[]; lineNumbers: number[];sourceHeaders:string[] }> {
  inspectZip(buffer);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as never); } catch { throw new DomainError(415, "Excel无法读取，请上传未加密的标准XLSX"); }
  const sheet = workbook.getWorksheet("data");
  if (!sheet || workbook.worksheets.length !== 1) throw new DomainError(400, "Excel必须只有一个名为data的数据工作表");
  if (sheet.rowCount > 10001 || sheet.rowCount * sheet.columnCount > 100000) throw new DomainError(413, "Excel行数或单元格超限");
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, cell => {if(cell.value&&typeof cell.value==='object')throw new DomainError(400,'Excel表头禁止公式和链接');headers.push(String(cell.value??''));});
  const sourceHeaders=[...headers],names=validateHeaders(headers,mapped);
  const rows: Row[] = [], lineNumbers: number[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row: Row = {}; let nonempty = false;
    for (let col = 1; col <= sheet.columnCount; col++) {
      const value = sheet.getRow(n).getCell(col).value;
      if (value && typeof value === "object") throw new DomainError(400, `第${n}行请使用纯文本或数值，禁止公式/链接；日期须为含时区文本`);
      if (col > headers.length && value !== null) throw new DomainError(400, "Excel数据超出表头范围");
      if (col <= headers.length) Object.defineProperty(row,names[col-1],{value:typeof value==='number'?value:String(value??''),enumerable:true,writable:true,configurable:true});
      if (value !== null && value !== "") nonempty = true;
    }
    if (nonempty) { rows.push(row); lineNumbers.push(n); }
  }
  return { rows, lineNumbers,sourceHeaders };
}

