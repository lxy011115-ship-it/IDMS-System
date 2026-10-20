import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseCsv, definitions } from '../server/imports.ts';
const directory='outputs/demo-data';
await mkdir(directory,{recursive:true});
for(const definition of Object.values(definitions)){
  const text=await readFile(`docs/upload-templates/${definition.file}`,'utf8');
  await copyFile(`docs/upload-templates/${definition.file}`,`${directory}/${definition.file}`);
  const {rows}=parseCsv(text), workbook=new ExcelJS.Workbook(), sheet=workbook.addWorksheet('data');
  sheet.addRow(definition.fields);
  for(const row of rows)sheet.addRow(definition.fields.map(f=>row[f]??''));
  sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF245B70'}};
  for(const column of sheet.columns)column.width=24;
  await workbook.xlsx.writeFile(`${directory}/${definition.file.replace('.csv','.xlsx')}`);
}
const production=await readFile('docs/upload-templates/production.csv','utf8');
await writeFile(`${directory}/production-error.csv`,production.replace(',1000,980,20',',1000,1200,20'),'utf8');
console.log(`Generated ${Object.keys(definitions).length} CSV/XLSX sample sets and one invalid production sample.`);
