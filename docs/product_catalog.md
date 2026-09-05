<!-- Asisto | Version: 5.00.043 | Fecha: 2026-09-05 -->
# Catálogo espejo de productos QR

La colección `qr_product_catalog` conserva artículos crudos separados por `tenantId` y una huella de la configuración de la API. No almacena las credenciales. Tiene un índice único por comercio, origen y `Codigo`, y otro por comercio, origen y `Codbarra`. Los códigos se guardan como texto para conservar ceros iniciales. Un código interno tiene prioridad; un código de barras duplicado responde 409 para evitar mostrar otro artículo.

La ficha y sus consultas de productos usan MongoDB primero. Hasta cinco minutos desde la última respuesta externa se considera vigente. Después del primer minuto, una consulta dispara renovación en segundo plano; con cinco minutos cumplidos, espera una respuesta actual de la API. Si esta falla, devuelve el error temporal y no sirve precios vencidos. Las renovaciones usan el código interno, comparten solicitudes simultáneas y respetan el límite y circuito de la v5.00.042. Los errores de persistencia no descartan una respuesta válida de la API.

Las respuestas externas se incorporan automáticamente. El formato visual se recalcula con la configuración actual (precios, etiquetas e imágenes). Cambiar el origen o autenticación crea otro ámbito de catálogo; los datos previos no se mezclan. No se ejecutan barridos periódicos ni sincronización completa: falta confirmar esas capacidades en el manual. Un código de barras no cargado depende de que la API pueda resolverlo.

## Carga inicial desde una exportación

El archivo JSON debe contener un arreglo de artículos completos con `Codigo`, `Codbarra` y los campos comerciales configurados, o ese arreglo bajo `items`, `articulos`, `productos` o `data`. Conservar los códigos entre comillas. La fecha corresponde a cuándo se obtuvieron los precios, no a cuándo se importan. Los artículos antiguos sirven para resolver códigos de barras, pero deben revalidarse para mostrar precios.

Validación sin escrituras (lee la configuración del dominio en MongoDB):

```powershell
node scripts/import_product_catalog.js --tenant DOMINIO --file catalogo.json --observed-at 2026-09-05T19:00:00Z
```

Agregar `--apply` escribe lotes de hasta 500 artículos. Requiere las variables habituales de MongoDB, o `.env`. No elimina productos ausentes ni reemplaza registros con fecha más reciente. Ante fallo parcial se puede repetir el comando. Validar el comercio y origen antes de aplicar. No se ha ejecutado una importación ni modificado producción durante la implementación.

## Verificación local

`node --test tests/product_catalog.test.js tests/qr_product_catalog.test.js tests/import_product_catalog.test.js` usa dobles de MongoDB y API sin conectar servicios. Cubre aislamiento entre comercios, código de barras, vigencia, actualización, 100 consultas concurrentes, errores, importación por lotes y el flujo del endpoint de productos. No es una medición de capacidad de MongoDB/Render. Antes de publicar, comprobar índices y carga con una base de prueba y el catálogo real.
