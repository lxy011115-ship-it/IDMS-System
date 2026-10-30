import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ExcelJS from 'exceljs';
import { parseCsv, definitions } from '../server/imports.ts';
export async function buildDemoFixtures(directory='outputs/demo-data'){
const templates=new URL('../docs/upload-templates/',import.meta.url);
await mkdir(directory,{recursive:true});
for(const definition of Object.values(definitions)){
  const text=await readFile(new URL(definition.file,templates),'utf8');
  await copyFile(new URL(definition.file,templates),`${directory}/${definition.file}`);
  const {rows}=parseCsv(text), workbook=new ExcelJS.Workbook(), sheet=workbook.addWorksheet('data');
  workbook.created=new Date('2000-01-01T00:00:00Z');workbook.modified=new Date('2000-01-01T00:00:00Z');
  sheet.addRow(definition.fields);
  for(const row of rows)sheet.addRow(definition.fields.map(f=>row[f]??''));
  sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF245B70'}};
  for(const column of sheet.columns)column.width=24;
  await workbook.xlsx.writeFile(`${directory}/${definition.file.replace('.csv','.xlsx')}`);
}
const production=await readFile(new URL('production.csv',templates),'utf8');
await writeFile(`${directory}/production-error.csv`,production.replace(',1000,980,20',',1000,1200,20'),'utf8');
return {sampleSets:Object.keys(definitions).length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const result=await buildDemoFixtures();console.log(`Generated ${result.sampleSets} CSV/XLSX sample sets and one invalid production sample.`);}
