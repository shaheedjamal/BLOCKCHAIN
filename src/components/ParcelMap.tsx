import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { Parcel } from '../types';

interface ParcelMapProps {
  parcels: Parcel[];
  selectedParcelId: string | null;
  onSelectParcel: (parcel: Parcel) => void;
}

export function ParcelMap({ parcels, selectedParcelId, onSelectParcel }: ParcelMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [13.0418, 80.2341],
      zoom: 14,
      zoomControl: true
    });

    // OpenStreetMap tile layer with clean fallback background if offline
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors · Synthetic DEMO Cadastral Overlays',
      maxZoom: 19
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();

    const bounds: L.LatLngExpression[] = [];

    for (const parcel of parcels) {
      const isSelected = parcel.parcel_id === selectedParcelId;
      const color =
        parcel.status === 'UNDER_MUTATION'
          ? '#D97706'
          : parcel.status === 'DISPUTED'
          ? '#DC2626'
          : isSelected
          ? '#1D4ED8'
          : '#0F172A';

      if (parcel.geojson_boundary?.geometry?.coordinates?.[0]) {
        const ring = parcel.geojson_boundary.geometry.coordinates[0].map(
          ([lng, lat]) => [lat, lng] as [number, number]
        );
        const poly = L.polygon(ring, {
          color,
          weight: isSelected ? 3 : 2,
          fillColor: color,
          fillOpacity: isSelected ? 0.28 : 0.14
        });

        poly.bindPopup(
          `<div style="font-family: 'Public Sans', sans-serif; font-size: 12px; min-width: 180px;">
            <div style="font-weight: 700; color: #0F172A; margin-bottom: 4px;">${parcel.parcel_id}</div>
            <div style="color: #475569;">Survey No: <strong>${parcel.survey_no}</strong></div>
            <div style="color: #475569;">Locality: ${parcel.locality}</div>
            <div style="color: #475569;">Area: ${parcel.area} · ${parcel.land_use}</div>
            <div style="color: #475569;">Geom Ref: ${parcel.geometry_ref}</div>
            <div style="color: #1D4ED8; margin-top: 4px;">Version v${parcel.version} · DEMO Geometry</div>
          </div>`
        );

        poly.on('click', () => onSelectParcel(parcel));
        poly.addTo(group);
        bounds.push(...ring);
      } else {
        const marker = L.circleMarker([parcel.centroid_lat, parcel.centroid_lng], {
          radius: isSelected ? 9 : 7,
          color,
          fillOpacity: 0.5
        });
        marker.on('click', () => onSelectParcel(parcel));
        marker.addTo(group);
        bounds.push([parcel.centroid_lat, parcel.centroid_lng]);
      }
    }

    if (selectedParcelId) {
      const target = parcels.find((p) => p.parcel_id === selectedParcelId);
      if (target) {
        map.setView([target.centroid_lat, target.centroid_lng], 16, { animate: true });
      }
    } else if (bounds.length > 0) {
      map.fitBounds(bounds as L.LatLngBoundsExpression, { padding: [32, 32], maxZoom: 15 });
    }
  }, [parcels, selectedParcelId, onSelectParcel]);

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-100">
      <div className="px-4 py-2.5 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-900">
          GIS Parcel Footprint Viewer (Leaflet · Synthetic DEMO Coordinates)
        </span>
        <span>Click any parcel polygon to inspect metadata & ledger history</span>
      </div>
      <div ref={containerRef} className="w-full h-80 sm:h-96 bg-slate-100" />
    </div>
  );
}
