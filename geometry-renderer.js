/**
 * LOGICPALS GEOMETRY SVG RENDERER
 * Dynamically generates geometric diagrams from problem data
 * Version: 1.0
 */

/**
 * Render a geometry problem with dynamic SVG
 * Falls back to image, then text description
 */
function renderGeometry(problem, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Try rendering strategies in order
    if (problem.geometry_data) {
        // Strategy 1: Dynamic SVG generation
        try {
            const svg = generateSVG(problem.geometry_data);
            container.innerHTML = svg;
            return;
        } catch (err) {
            console.warn('SVG generation failed:', err);
        }
    }

    if (problem.diagram_url) {
        // Strategy 2: Static image
        container.innerHTML = `
            <img src="${problem.diagram_url}" 
                 alt="${problem.diagram_description || 'Geometry diagram'}"
                 style="max-width: 100%; height: auto; border-radius: 8px;">
        `;
        return;
    }

    if (problem.diagram_description) {
        // Strategy 3: Text description with ASCII art
        container.innerHTML = `
            <div style="
                background: #F9FAFB;
                border: 2px dashed #D1D5DB;
                border-radius: 12px;
                padding: 20px;
                font-family: 'Courier New', monospace;
                white-space: pre-line;
                line-height: 1.8;
                color: #374151;
            ">
${problem.diagram_description}
            </div>
        `;
        return;
    }

    // No visual data available
    container.innerHTML = `
        <div style="
            background: #FEF3C7;
            border: 1px solid #FCD34D;
            border-radius: 8px;
            padding: 16px;
            color: #92400E;
            text-align: center;
        ">
            ⚠️ Diagram not available. Please read the problem carefully.
        </div>
    `;
}

/**
 * Generate SVG from geometry data
 */
function generateSVG(geometryData) {
    const type = geometryData.type;

    switch (type) {
        case 'triangle':
            return generateTriangle(geometryData);
        case 'circle':
            return generateCircle(geometryData);
        case 'rectangle':
            return generateRectangle(geometryData);
        case 'polygon':
            return generatePolygon(geometryData);
        case 'graph':
            return generateGraph(geometryData);
        case 'angle':
            return generateAngle(geometryData);
        default:
            throw new Error(`Unknown geometry type: ${type}`);
    }
}

/**
 * Generate Triangle SVG
 */
function generateTriangle(data) {
    const width = data.width || 400;
    const height = data.height || 300;
    const points = data.points || [];
    const sides = data.sides || [];
    const angles = data.angles || [];

    // Create SVG
    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">`;

    // Background
    svg += `<rect width="${width}" height="${height}" fill="#FFFBEB"/>`;

    // Draw triangle
    if (points.length >= 3) {
        const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
        svg += `<polygon points="${pointsStr}" fill="rgba(251, 191, 36, 0.1)" stroke="#F59E0B" stroke-width="3"/>`;

        // Draw vertex labels
        points.forEach(p => {
            svg += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#D97706"/>`;
            svg += `<text x="${p.x + (p.offset_x || 0)}" y="${p.y + (p.offset_y || -10)}" 
                         font-size="18" font-weight="700" fill="#78350F" text-anchor="middle">
                    ${p.label}
                    </text>`;
        });

        // Draw side labels (lengths)
        sides.forEach(side => {
            const p1 = points.find(p => p.label === side.from);
            const p2 = points.find(p => p.label === side.to);
            if (p1 && p2) {
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;
                svg += `<text x="${midX}" y="${midY}" 
                             font-size="14" font-weight="600" fill="#92400E" 
                             text-anchor="middle">
                        ${side.length}
                        </text>`;
            }
        });

        // Draw angle markers
        angles.forEach(angle => {
            if (angle.show) {
                const point = points.find(p => p.label === angle.at);
                if (point) {
                    if (angle.degrees === 90) {
                        // Right angle marker
                        const size = 15;
                        svg += `<rect x="${point.x - size/2}" y="${point.y - size/2}" 
                                     width="${size}" height="${size}" 
                                     fill="none" stroke="#F59E0B" stroke-width="2"/>`;
                    } else {
                        // Arc for other angles
                        const radius = 20;
                        svg += `<circle cx="${point.x}" cy="${point.y}" r="${radius}" 
                                       fill="none" stroke="#F59E0B" stroke-width="1" 
                                       stroke-dasharray="5,5"/>`;
                        svg += `<text x="${point.x + radius + 10}" y="${point.y}" 
                                     font-size="12" fill="#92400E">
                                ${angle.degrees}°
                                </text>`;
                    }
                }
            }
        });
    }

    svg += '</svg>';
    return svg;
}

/**
 * Generate Circle SVG
 */
function generateCircle(data) {
    const width = data.width || 400;
    const height = data.height || 300;
    const cx = data.center_x || width / 2;
    const cy = data.center_y || height / 2;
    const radius = data.radius || 80;
    const showCenter = data.show_center !== false;
    const showRadius = data.show_radius !== false;

    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">`;
    
    // Background
    svg += `<rect width="${width}" height="${height}" fill="#FFFBEB"/>`;

    // Draw circle
    svg += `<circle cx="${cx}" cy="${cy}" r="${radius}" 
                   fill="rgba(251, 191, 36, 0.1)" stroke="#F59E0B" stroke-width="3"/>`;

    // Draw center point
    if (showCenter) {
        svg += `<circle cx="${cx}" cy="${cy}" r="4" fill="#D97706"/>`;
        svg += `<text x="${cx}" y="${cy - 10}" font-size="16" font-weight="700" 
                     fill="#78350F" text-anchor="middle">O</text>`;
    }

    // Draw radius line
    if (showRadius) {
        svg += `<line x1="${cx}" y1="${cy}" x2="${cx + radius}" y2="${cy}" 
                     stroke="#F59E0B" stroke-width="2" stroke-dasharray="5,5"/>`;
        svg += `<text x="${cx + radius/2}" y="${cy - 10}" font-size="14" font-weight="600" 
                     fill="#92400E" text-anchor="middle">${data.radius_label || 'r'}</text>`;
    }

    svg += '</svg>';
    return svg;
}

/**
 * Generate Rectangle SVG
 */
function generateRectangle(data) {
    const width = data.width || 400;
    const height = data.height || 300;
    const rectWidth = data.rect_width || 200;
    const rectHeight = data.rect_height || 120;
    const x = data.x || (width - rectWidth) / 2;
    const y = data.y || (height - rectHeight) / 2;

    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">`;
    
    // Background
    svg += `<rect width="${width}" height="${height}" fill="#FFFBEB"/>`;

    // Draw rectangle
    svg += `<rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" 
                 fill="rgba(251, 191, 36, 0.1)" stroke="#F59E0B" stroke-width="3"/>`;

    // Labels
    if (data.width_label) {
        svg += `<text x="${x + rectWidth/2}" y="${y + rectHeight + 25}" 
                     font-size="14" font-weight="600" fill="#92400E" text-anchor="middle">
                ${data.width_label}
                </text>`;
    }
    if (data.height_label) {
        svg += `<text x="${x - 15}" y="${y + rectHeight/2}" 
                     font-size="14" font-weight="600" fill="#92400E" text-anchor="middle">
                ${data.height_label}
                </text>`;
    }

    svg += '</svg>';
    return svg;
}

/**
 * Generate Graph (nodes and edges) SVG
 */
function generateGraph(data) {
    const width = data.width || 400;
    const height = data.height || 300;
    const nodes = data.nodes || [];
    const edges = data.edges || [];

    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">`;
    
    // Background
    svg += `<rect width="${width}" height="${height}" fill="#FFFBEB"/>`;

    // Draw edges first (so they appear behind nodes)
    edges.forEach(edge => {
        const from = nodes.find(n => n.id === edge.from);
        const to = nodes.find(n => n.id === edge.to);
        if (from && to) {
            svg += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" 
                         stroke="#F59E0B" stroke-width="2"/>`;
            
            // Edge label (optional)
            if (edge.label) {
                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;
                svg += `<text x="${midX}" y="${midY - 5}" font-size="12" 
                             fill="#92400E" text-anchor="middle">${edge.label}</text>`;
            }
        }
    });

    // Draw nodes
    nodes.forEach(node => {
        svg += `<circle cx="${node.x}" cy="${node.y}" r="20" 
                       fill="white" stroke="#F59E0B" stroke-width="3"/>`;
        svg += `<text x="${node.x}" y="${node.y + 5}" font-size="16" font-weight="700" 
                     fill="#78350F" text-anchor="middle">${node.label}</text>`;
    });

    svg += '</svg>';
    return svg;
}

/**
 * Generate Angle SVG
 */
function generateAngle(data) {
    const width = data.width || 400;
    const height = data.height || 300;
    const cx = data.center_x || width / 2;
    const cy = data.center_y || height / 2;
    const angle = data.degrees || 60;
    const length = data.length || 100;

    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">`;
    
    // Background
    svg += `<rect width="${width}" height="${height}" fill="#FFFBEB"/>`;

    // Draw angle rays
    const angleRad = (angle * Math.PI) / 180;
    const x1 = cx + length;
    const y1 = cy;
    const x2 = cx + length * Math.cos(angleRad);
    const y2 = cy - length * Math.sin(angleRad);

    svg += `<line x1="${cx}" y1="${cy}" x2="${x1}" y2="${y1}" stroke="#F59E0B" stroke-width="3"/>`;
    svg += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#F59E0B" stroke-width="3"/>`;

    // Draw arc
    const arcRadius = 40;
    svg += `<path d="M ${cx + arcRadius} ${cy} A ${arcRadius} ${arcRadius} 0 0 0 ${cx + arcRadius * Math.cos(angleRad)} ${cy - arcRadius * Math.sin(angleRad)}" 
                 fill="none" stroke="#F59E0B" stroke-width="2"/>`;

    // Angle label
    svg += `<text x="${cx + arcRadius + 20}" y="${cy - arcRadius/2}" 
                 font-size="18" font-weight="700" fill="#78350F">${angle}°</text>`;

    svg += '</svg>';
    return svg;
}

/**
 * Generate Polygon SVG
 */
function generatePolygon(data) {
    const width = data.width || 400;
    const height = data.height || 300;
    const points = data.points || [];

    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">`;
    
    // Background
    svg += `<rect width="${width}" height="${height}" fill="#FFFBEB"/>`;

    if (points.length >= 3) {
        const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
        svg += `<polygon points="${pointsStr}" 
                        fill="rgba(251, 191, 36, 0.1)" stroke="#F59E0B" stroke-width="3"/>`;

        // Vertex labels
        points.forEach(p => {
            svg += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#D97706"/>`;
            svg += `<text x="${p.x}" y="${p.y - 10}" font-size="16" font-weight="700" 
                         fill="#78350F" text-anchor="middle">${p.label}</text>`;
        });
    }

    svg += '</svg>';
    return svg;
}

// Export for use in other files
window.GeometryRenderer = {
    renderGeometry,
    generateSVG,
    generateTriangle,
    generateCircle,
    generateRectangle,
    generateGraph,
    generateAngle,
    generatePolygon
};
